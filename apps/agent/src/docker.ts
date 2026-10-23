import Docker from 'dockerode';
import readline from 'node:readline';
import { PassThrough, type Readable } from 'node:stream';
import {
	LABELS,
	type ContainerRuntime,
	type ManagedContainer,
	type OnLogLine,
	type RunSpec
} from './runtime';

/** `nginx` → `nginx:latest`; pulling an untagged image would otherwise fetch every tag. */
export const withTag = (image: string) =>
	image.includes('@') || /:[^/]+$/.test(image) ? image : `${image}:latest`;

const statusCode = (error: unknown) => (error as { statusCode?: number })?.statusCode;

/** ContainerRuntime backed by the Docker Engine API (honours DOCKER_HOST). */
export class DockerRuntime implements ContainerRuntime {
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
						startedAt: running ? info.State.StartedAt : null
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
		await new Promise<void>((resolve, reject) =>
			this.docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve()))
		);
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
			await this.docker.getContainer(name).remove({ force: true });
		} catch (error) {
			if (statusCode(error) !== 404) throw error;
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
