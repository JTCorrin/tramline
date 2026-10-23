import type { BuildReport, DesiredBuild } from '@tramline/contracts';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { BUILDKIT_IMAGE, RAILPACK } from './pins';
import { railpackBinary } from './railpack';
import { LABELS, type ContainerRuntime, type ManagedContainer } from './runtime';
import { hash } from './spec';

/** Keep this many built images per service so recent rollbacks don't need a rebuild. */
export const KEEP_IMAGES = 3;

const HOME = '/home/user';
const RAILPACK_PATH = `${HOME}/bin/railpack`;

export const builderName = (nodeId: string) => `tramline-builder-${nodeId}`;

export interface BuilderOptions {
	stateDir: string;
	nodeId: () => string;
	/** Build output, line by line, for the deployment's log. */
	onLine: (deploymentId: string, line: string) => void;
	fetcher?: typeof fetch;
	log?: (message: string) => void;
}

/**
 * Builds deployments from source inside one rootless BuildKit container per
 * node: clone → Railpack (or a Dockerfile) → image loaded into the local
 * Docker. Variables reach the build only as BuildKit secrets, set on the
 * build process alone, so they never land in the image, the plan or the logs.
 */
export class Builder {
	#ready: Promise<void> | null = null;

	constructor(
		private runtime: ContainerRuntime,
		private options: BuilderOptions
	) {}

	get name() {
		return builderName(this.options.nodeId());
	}

	async build(job: DesiredBuild): Promise<BuildReport> {
		const report = (
			state: BuildReport['state'],
			extra: Partial<BuildReport> = {}
		): BuildReport => ({
			deploymentId: job.deploymentId,
			state,
			image: null,
			commit: null,
			error: null,
			...extra
		});
		const say = (line: string) => this.options.onLine(job.deploymentId, line);
		const work = `${HOME}/work/${job.deploymentId}`;
		let commit: string | null = null;

		try {
			await this.ensure();
			const run = (cmd: string[], env?: Record<string, string>, stdout?: NodeJS.WritableStream) =>
				this.runtime.execStream(this.name, cmd, { env, stdout, onLine: (_, line) => say(line) });

			await run(['rm', '-rf', work]);
			await run(['mkdir', '-p', `${work}/plan`]);

			// 1. source
			say(`Cloning ${job.repo} (${job.commit ?? job.ref})`);
			const output: string[] = [];
			const clone = await this.runtime.execStream(this.name, ['sh', '-c', CLONE_SCRIPT], {
				env: {
					...gitAuth(job.repo, job.token),
					REPO: job.repo,
					REF: job.commit ?? job.ref,
					DIR: `${work}/src`
				},
				onLine: (_, line) => (/^[0-9a-f]{40}$/.test(line) ? output.push(line) : say(line))
			});
			if (clone !== 0)
				return report('failed', { error: `Could not fetch ${job.ref} from ${job.repo}` });
			commit = output.at(-1) ?? null;
			if (commit) say(`Checked out ${commit.slice(0, 7)}`);

			const context = path.posix.join(work, 'src', safeSubdirectory(job.rootDirectory));
			const dockerfile = path.posix.join(context, job.dockerfilePath ?? 'Dockerfile');
			const useDockerfile =
				job.builder === 'dockerfile' || (await run(['test', '-f', dockerfile])) === 0;

			// secrets are named on the command line, but their values only ever travel in the build's environment
			const secretFlags = Object.keys(job.secrets).flatMap((key) => [
				'--secret',
				`id=${key},env=${key}`
			]);
			const outputFlags = ['--output', `type=docker,name=${job.image}`];
			let buildctl: string[];

			// 2. plan
			if (useDockerfile) {
				say(`Building with ${path.posix.relative(context, dockerfile)}`);
				buildctl = [
					'buildctl',
					'build',
					'--progress=plain',
					'--frontend=dockerfile.v0',
					'--local',
					`context=${context}`,
					'--local',
					`dockerfile=${path.posix.dirname(dockerfile)}`,
					'--opt',
					`filename=${path.posix.basename(dockerfile)}`,
					...secretFlags,
					...outputFlags
				];
			} else {
				say(`Building with Railpack ${RAILPACK.version}`);
				const prepare = [
					RAILPACK_PATH,
					'prepare',
					context,
					'--plan-out',
					`${work}/plan/railpack-plan.json`,
					'--info-out',
					`${work}/plan/railpack-info.json`,
					...(job.buildCommand ? ['--build-cmd', job.buildCommand] : []),
					...(job.startCommand ? ['--start-cmd', job.startCommand] : []),
					...Object.entries(job.secrets).flatMap(([key, value]) => ['--env', `${key}=${value}`])
				];
				let planned = await run(prepare);
				if (planned === 75) planned = await run(prepare); // transient, e.g. a download failed
				if (planned !== 0)
					return report('failed', { commit, error: 'Railpack could not plan this app' });
				buildctl = [
					'buildctl',
					'build',
					'--progress=plain',
					'--frontend=gateway.v0',
					'--opt',
					`source=${RAILPACK.frontend}`,
					'--local',
					`context=${context}`,
					'--local',
					`dockerfile=${work}/plan`,
					'--opt',
					`build-arg:cache-key=${job.serviceId}`,
					'--opt',
					`build-arg:secrets-hash=${secretsHash(job.secrets)}`,
					...secretFlags,
					...outputFlags
				];
			}

			// 3. build, streaming the image straight into the local Docker
			const tarball = new PassThrough();
			const loaded = this.runtime.loadImage(tarball);
			// the exec's output stream ends `tarball` once everything is flushed; ending it here
			// instead would cut off data still buffered for a slower `docker load`
			const built = await run(buildctl, job.secrets, tarball);
			await loaded.catch((error) => {
				if (built === 0) throw error;
			});
			if (built !== 0)
				return report('failed', { commit, error: 'The build failed; see the build log' });

			const image = await this.runtime.imageId(job.image);
			if (!image) return report('failed', { commit, error: 'The built image was not found' });
			say(`Built ${image.slice(7, 19)}`);
			await this.#collect(job);
			return report('succeeded', { image, commit });
		} catch (error) {
			return report('failed', {
				commit,
				error: error instanceof Error ? error.message : String(error)
			});
		} finally {
			await this.runtime
				.execStream(this.name, ['rm', '-rf', work], { onLine: () => {} })
				.catch(() => {});
		}
	}

	/** Starts the builder container and installs the Railpack CLI in it, once. */
	ensure() {
		this.#ready ??= this.#start().catch((error) => {
			this.#ready = null;
			throw error;
		});
		return this.#ready;
	}

	async #start() {
		const nodeId = this.options.nodeId();
		const spec = {
			name: this.name,
			image: BUILDKIT_IMAGE,
			cmd: ['--oci-worker-no-process-sandbox'],
			env: {},
			network: 'bridge',
			aliases: [],
			restart: { name: 'always' as const, maxRetries: 0 },
			volumes: [{ name: `tramline-buildkit-${nodeId}`, target: `${HOME}/.local/share/buildkit` }],
			// rootless BuildKit runs as uid 1000 and is never --privileged, but its user
			// namespace needs setuid helpers and Docker's seccomp/AppArmor profiles relaxed
			security: {
				capabilities: 'docker-default' as const,
				pidsLimit: 4096,
				memoryMb: null,
				readOnlyRootFilesystem: false,
				noNewPrivileges: false,
				unconfined: true
			},
			labels: {
				[LABELS.managed]: 'true',
				[LABELS.node]: nodeId,
				[LABELS.role]: 'builder',
				[LABELS.spec]: hash({ image: BUILDKIT_IMAGE })
			}
		};

		const existing = (await this.runtime.list()).find(
			(c: ManagedContainer) => c.name === this.name
		);
		if (
			existing?.labels[LABELS.spec] !== spec.labels[LABELS.spec] ||
			existing?.status !== 'running'
		) {
			if (existing) await this.runtime.remove(this.name);
			if (!(await this.runtime.hasImage(BUILDKIT_IMAGE))) await this.runtime.pull(BUILDKIT_IMAGE);
			await this.runtime.run(spec);
		}

		const binary = await railpackBinary(
			this.options.stateDir,
			await this.runtime.arch(),
			this.options.fetcher
		);
		await this.runtime.execStream(this.name, ['mkdir', '-p', path.posix.dirname(RAILPACK_PATH)], {
			onLine: () => {}
		});
		await this.runtime.putFile(this.name, RAILPACK_PATH, binary, 0o755);
		// buildkitd takes a moment to accept connections after the container starts
		for (let attempt = 0; attempt < 30; attempt++) {
			const ready = await this.runtime.execStream(this.name, ['buildctl', 'debug', 'workers'], {
				onLine: () => {}
			});
			if (ready === 0) return;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		throw new Error('The builder did not start');
	}

	/** Removes older built images of the service, keeping the newest few. */
	async #collect(job: DesiredBuild) {
		const repository = job.image.split(':')[0]!;
		const images = await this.runtime.listImages(repository);
		for (const image of images.slice(KEEP_IMAGES)) await this.runtime.removeImage(image.id);
	}
}

/** Clones one ref shallowly into $DIR and prints the commit. Inputs arrive as env vars, never interpolated. */
export const CLONE_SCRIPT = [
	'set -e',
	'git init -q "$DIR"',
	'cd "$DIR"',
	'git remote add origin "$REPO"',
	'git fetch -q --depth 1 origin "$REF"',
	'git checkout -q FETCH_HEAD',
	'git rev-parse HEAD'
].join('\n');

/** Git config for a token, passed through the environment so it never appears in a URL or argument. */
export function gitAuth(repo: string, token: string | null): Record<string, string> {
	const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
	if (!token) return env;
	const origin = new URL(repo).origin;
	const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
	return {
		...env,
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`
	};
}

/**
 * A root directory relative to the repository. Normalising it as an absolute
 * path resolves any `..` at the root, so it can never point outside the clone.
 */
export function safeSubdirectory(rootDirectory: string) {
	return path.posix.normalize(`/${rootDirectory}`).slice(1);
}

/** Changes when any secret's value changes, so cached steps that used it rebuild. */
export const secretsHash = (secrets: Record<string, string>) =>
	createHash('sha256')
		.update(JSON.stringify(Object.entries(secrets).sort(([a], [b]) => a.localeCompare(b))))
		.digest('hex')
		.slice(0, 16);
