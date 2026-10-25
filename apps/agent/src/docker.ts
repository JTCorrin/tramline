import Docker from 'dockerode';
import readline from 'node:readline';
import { PassThrough, type Readable } from 'node:stream';
import { pack } from 'tar-stream';
import {
	LABELS,
	type ContainerRuntime,
	type ExecStreamOptions,
	type ManagedContainer,
	type OnLogLine,
	type RunSpec
} from './runtime';

/** `nginx` → `nginx:latest`; pulling an untagged image would otherwise fetch every tag. */
export const withTag = (image: string) =>
	image.includes('@') || /:[^/]+$/.test(image) ? image : `${image}:latest`;

/** `ghcr.io/acme/api:1@sha256:…` → `ghcr.io/acme/api`. A port in the registry host is not a tag. */
export const repositoryOf = (reference: string) => reference.split('@')[0]!.replace(/:[^/]+$/, '');

const statusCode = (error: unknown) => (error as { statusCode?: number })?.statusCode;

/** ContainerRuntime backed by the Docker Engine API (honours DOCKER_HOST). */
export class DockerRuntime implements ContainerRuntime {
	/** Image ID → `repo@sha256:…`, so listing containers doesn't inspect every image every time. */
	#digests = new Map<string, string | null>();

	constructor(private docker = new Docker()) {}

	async version() {
		return (await this.docker.version()).Version;
	}

	async ensureNetwork(name: string) {
		const networks = await this.docker.listNetworks({ filters: { name: [name] } });
		if (networks.some((n) => n.Name === name)) return;
		await this.docker.createNetwork({
			Name: name,
			Driver: 'bridge',
			Labels: { [LABELS.managed]: 'true' }
		});
	}

	async list(): Promise<ManagedContainer[]> {
		const summaries = await this.docker.listContainers({
			all: true,
			filters: { label: [`${LABELS.managed}=true`] }
		});
		const containers = await Promise.all(
			summaries.map(async (summary) => {
				try {
					const info = await this.docker.getContainer(summary.Id).inspect();
					const running = info.State.Running;
					return {
						name: info.Name.replace(/^\//, ''),
						labels: info.Config.Labels ?? {},
						networks: Object.keys(info.NetworkSettings.Networks ?? {}),
						status: (info.State.Restarting
							? 'restarting'
							: info.State.Status) as ManagedContainer['status'],
						exitCode: running ? null : info.State.ExitCode,
						restartCount: info.RestartCount,
						startedAt: running ? info.State.StartedAt : null,
						imageDigest: await this.#digest(info.Image)
					};
				} catch (error) {
					if (statusCode(error) === 404) return null; // removed since we listed it
					throw error;
				}
			})
		);
		return containers.filter((c) => c !== null);
	}

	async hasImage(image: string) {
		try {
			await this.docker.getImage(withTag(image)).inspect();
			return true;
		} catch (error) {
			if (statusCode(error) === 404) return false;
			throw error;
		}
	}

	async pull(image: string) {
		const stream = await this.docker.pull(withTag(image));
		await follow(this.docker, stream);
	}

	async run(spec: RunSpec) {
		const ports = spec.ports ?? [];
		const container = await this.docker.createContainer({
			name: spec.name,
			Image: withTag(spec.image),
			Cmd: spec.cmd,
			Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
			Labels: spec.labels,
			ExposedPorts: Object.fromEntries(ports.map((p) => [`${p.container}/tcp`, {}])),
			HostConfig: {
				RestartPolicy: { Name: spec.restart.name, MaximumRetryCount: spec.restart.maxRetries },
				NetworkMode: spec.network,
				...(spec.security.capabilities === 'docker-default'
					? {}
					: { CapDrop: ['ALL'], CapAdd: spec.security.capabilities }),
				SecurityOpt: [
					...(spec.security.noNewPrivileges === false ? [] : ['no-new-privileges:true']),
					...(spec.security.unconfined ? ['seccomp=unconfined', 'apparmor=unconfined'] : [])
				],
				Mounts: (spec.volumes ?? []).map((v) => ({
					Type: 'volume' as const,
					Source: v.name,
					Target: v.target,
					ReadOnly: v.readOnly ?? false
				})),
				PidsLimit: spec.security.pidsLimit,
				Init: spec.security.init ?? false,
				Privileged: false,
				...(spec.security.memoryMb ? { Memory: spec.security.memoryMb * 1024 * 1024 } : {}),
				...(spec.security.readOnlyRootFilesystem
					? { ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' } }
					: {}),
				PortBindings: Object.fromEntries(
					ports.map((p) => [`${p.container}/tcp`, [{ HostPort: String(p.host) }]])
				),
				Binds: spec.binds
			},
			NetworkingConfig: { EndpointsConfig: { [spec.network]: { Aliases: spec.aliases } } }
		});
		await container.start();
	}

	async remove(name: string) {
		try {
			// v: also the anonymous volumes an image declares (redis:7's /data); named ones stay
			await this.docker.getContainer(name).remove({ force: true, v: true });
		} catch (error) {
			if (statusCode(error) !== 404) throw error;
		}
	}

	async stop(name: string, timeoutSeconds: number) {
		try {
			await this.docker.getContainer(name).stop({ t: timeoutSeconds });
		} catch (error) {
			// 304: already stopped; 404: gone
			if (![304, 404].includes(statusCode(error) ?? 0)) throw error;
		}
	}

	async ensureVolume(name: string, labels: Record<string, string>) {
		try {
			await this.docker.getVolume(name).inspect();
		} catch (error) {
			if (statusCode(error) !== 404) throw error;
			await this.docker.createVolume({ Name: name, Labels: labels });
		}
	}

	async listVolumes() {
		const { Volumes } = await this.docker.listVolumes({
			filters: { label: [`${LABELS.managed}=true`] }
		});
		return (Volumes ?? []).map((v) => ({ name: v.Name, labels: v.Labels ?? {} }));
	}

	async removeVolume(name: string) {
		try {
			await this.docker.getVolume(name).remove();
			return true;
		} catch (error) {
			if (statusCode(error) === 404) return true;
			if (statusCode(error) === 409) return false;
			throw error;
		}
	}

	async connect(container: string, network: string) {
		await this.docker.getNetwork(network).connect({ Container: container });
	}

	async exec(container: string, cmd: string[]) {
		const exec = await this.docker.getContainer(container).exec({
			Cmd: cmd,
			AttachStdout: true,
			AttachStderr: true
		});
		const stream = await exec.start({});
		const output = new PassThrough();
		let text = '';
		output.on('data', (chunk: Buffer) => (text += chunk.toString()));
		this.docker.modem.demuxStream(stream, output, output);
		await new Promise<void>((resolve) => stream.on('end', () => resolve()));
		const info = await exec.inspect();
		return { exitCode: info.ExitCode ?? 1, output: text };
	}

	async #digest(imageId: string) {
		if (!this.#digests.has(imageId)) {
			try {
				const image = await this.docker.getImage(imageId).inspect();
				this.#digests.set(imageId, image.RepoDigests?.[0] ?? null);
			} catch {
				return null;
			}
		}
		return this.#digests.get(imageId) ?? null;
	}

	async arch() {
		return (await this.docker.info()).Architecture as string;
	}

	async execStream(container: string, cmd: string[], options: ExecStreamOptions) {
		const exec = await this.docker.getContainer(container).exec({
			Cmd: cmd,
			Env: Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`),
			AttachStdout: true,
			AttachStderr: true
		});
		const stream = await exec.start({});
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		this.docker.modem.demuxStream(stream, stdout, stderr);
		const done: Promise<unknown>[] = [];
		if (options.stdout) stdout.pipe(options.stdout as NodeJS.WritableStream);
		else done.push(lines(stdout, (line) => options.onLine('stdout', line)));
		done.push(lines(stderr, (line) => options.onLine('stderr', line)));
		await new Promise<void>((resolve, reject) => {
			stream.on('end', () => resolve());
			stream.on('error', reject);
		});
		stdout.end();
		stderr.end();
		await Promise.all(done);
		return (await exec.inspect()).ExitCode ?? 1;
	}

	async putFile(container: string, path: string, content: Buffer, mode: number) {
		const archive = pack();
		const slash = path.lastIndexOf('/');
		archive.entry({ name: path.slice(slash + 1), mode }, content);
		archive.finalize();
		await this.docker
			.getContainer(container)
			.putArchive(archive as unknown as NodeJS.ReadableStream, {
				path: path.slice(0, slash) || '/'
			});
	}

	async putArchive(container: string, path: string, archive: NodeJS.ReadableStream) {
		await this.docker.getContainer(container).putArchive(archive, { path });
	}

	async loadImage(tarball: NodeJS.ReadableStream) {
		const stream = await this.docker.loadImage(tarball);
		await follow(this.docker, stream);
	}

	async repoDigest(reference: string) {
		try {
			const image = await this.docker.getImage(withTag(reference)).inspect();
			const repository = repositoryOf(reference);
			const digests = image.RepoDigests ?? [];
			// an image pulled under several names has a digest per repository
			return digests.find((d) => repositoryOf(d) === repository) ?? digests[0] ?? null;
		} catch (error) {
			if (statusCode(error) === 404) return null;
			throw error;
		}
	}

	async imageId(reference: string) {
		try {
			return (await this.docker.getImage(reference).inspect()).Id;
		} catch (error) {
			if (statusCode(error) === 404) return null;
			throw error;
		}
	}

	async listImages(repository: string) {
		const images = await this.docker.listImages({ filters: { reference: [repository] } });
		return images
			.map((image) => ({ id: image.Id, tags: image.RepoTags ?? [], created: image.Created }))
			.sort((a, b) => b.created - a.created);
	}

	async removeImage(id: string) {
		try {
			await this.docker.getImage(id).remove({ force: false });
		} catch (error) {
			// 409: still used by a container; 404: already gone
			if (![404, 409].includes(statusCode(error) ?? 0)) throw error;
		}
	}

	logs(name: string, since: number, onLine: OnLogLine, onEnd: () => void) {
		let stream: Readable | undefined;
		let cancelled = false;
		this.docker
			.getContainer(name)
			.logs({ follow: true, stdout: true, stderr: true, timestamps: true, since })
			.then((s) => {
				stream = s as unknown as Readable;
				if (cancelled) return stream.destroy();
				const streams = { stdout: new PassThrough(), stderr: new PassThrough() };
				this.docker.modem.demuxStream(stream, streams.stdout, streams.stderr);
				for (const [kind, pass] of Object.entries(streams) as [
					'stdout' | 'stderr',
					PassThrough
				][]) {
					readline.createInterface({ input: pass }).on('line', (raw) => {
						// "2026-10-23T10:00:00.123456789Z message"
						const space = raw.indexOf(' ');
						onLine(kind, raw.slice(0, space), raw.slice(space + 1));
					});
				}
				stream.on('close', () => {
					streams.stdout.end();
					streams.stderr.end();
					onEnd();
				});
			})
			.catch(() => onEnd());
		return () => {
			cancelled = true;
			stream?.destroy();
		};
	}
}

/** Calls `onLine` for each line of a stream; resolves when it ends. */
function lines(stream: Readable, onLine: (line: string) => void) {
	return new Promise<void>((resolve) => {
		readline.createInterface({ input: stream }).on('line', onLine).on('close', resolve);
	});
}

/**
 * Waits for a Docker progress stream (pull, load) to finish. Docker reports
 * failures as `{"error": …}` lines inside a successful response, which
 * dockerode's followProgress treats as ordinary progress, so check for them.
 */
export function follow(docker: Docker, stream: NodeJS.ReadableStream) {
	return new Promise<void>((resolve, reject) =>
		docker.modem.followProgress(stream, (error: Error | null, output: { error?: string }[]) => {
			const reported = output?.find((line) => line.error)?.error;
			if (error) reject(error);
			else if (reported) reject(new Error(reported));
			else resolve();
		})
	);
}
