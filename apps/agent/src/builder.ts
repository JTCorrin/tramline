import type {
	BuildReport,
	DesiredBuild,
	DesiredScan,
	ScanMode,
	ScanResult
} from '@tramline/contracts';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { BUILDKIT_IMAGE, RAILPACK, TRIVY } from './pins';
import { RAILPACK_TOOL, releaseBinary, TRIVY_TOOL, type ReleaseTool } from './railpack';
import { LABELS, type ContainerRuntime } from './runtime';
import {
	blockedMessage,
	describe,
	scanError,
	SCANNER,
	summarise,
	type TrivyReport
} from './scanner';

/** Keep this many built images per service so recent rollbacks don't need a rebuild. */
export const KEEP_IMAGES = 3;

const HOME = '/home/user';
const WORK = `${HOME}/work`;
const BUILDKIT_STATE = `${HOME}/.local/share/buildkit`;
/**
 * Railpack, Trivy and Trivy's vulnerability database live on the cache
 * volume (owned by the unprivileged builder user), installed once per
 * version. Build steps run in BuildKit's process sandbox, so they can't
 * reach them.
 */
const TOOLS = `${BUILDKIT_STATE}/tools`;
const RAILPACK_PATH = `${TOOLS}/railpack-${RAILPACK.version}`;
const TRIVY_PATH = `${TOOLS}/trivy-${TRIVY.version}`;
const TRIVY_CACHE = `${BUILDKIT_STATE}/trivy-cache`;

/** Each build or scan gets a fresh builder of its own, removed afterwards. */
export const jobContainerName = (deploymentId: string) => `tl-build-${deploymentId}`;
/** BuildKit's cache, one per organization so one can't poison another's builds. */
export const cacheVolume = (nodeId: string, scope: string) =>
	`tramline-buildkit-${nodeId}-${scope.replace(/[^\w-]/g, '')}`;
/** Registry images are scanned without running anyone's code; they share one volume. */
const SCAN_SCOPE = 'scans';

/** Memory a build may use (TRAMLINE_BUILD_MEMORY_MB), and how many processes. */
export const BUILD_MEMORY_MB = 4096;
const BUILD_PIDS = 4096;

export interface BuilderOptions {
	stateDir: string;
	nodeId: () => string;
	/** Build output, line by line, for the deployment's log. */
	onLine: (deploymentId: string, line: string) => void;
	fetcher?: typeof fetch;
	log?: (message: string) => void;
	/** Fetches a verified tool binary; tests pass a fake. */
	tools?: (tool: ReleaseTool, arch: string) => Promise<Buffer>;
	memoryMb?: number;
	/** How long buildkitd gets to come up, polled every `readyPollMs`. */
	readyAttempts?: number;
	readyPollMs?: number;
}

/**
 * Builds deployments from source inside one rootless BuildKit container per
 * node: clone → Railpack (or a Dockerfile) → image loaded into the local
 * Docker. Variables reach the build as BuildKit secrets, so BuildKit itself
 * never writes them into image layers, the plan or the logs. A build step
 * that prints or copies a secret still can: that's the application's code.
 * Builds on a node share this one builder; see the roadmap's build-isolation
 * work before running builds for mutually untrusted organizations.
 */
export class Builder {
	constructor(
		private runtime: ContainerRuntime,
		private options: BuilderOptions
	) {}

	/**
	 * Removes builders a previous run of the agent left behind (a build cut
	 * short by a restart), and the single shared builder older agents used.
	 */
	async reap() {
		const nodeId = this.options.nodeId();
		for (const container of await this.runtime.list()) {
			const role = container.labels[LABELS.role];
			if (container.labels[LABELS.node] !== nodeId) continue;
			if (role === 'build-job' || role === 'builder') await this.runtime.remove(container.name);
		}
	}

	/**
	 * Builds a deployment in a builder of its own. Aborting `signal` removes
	 * that builder, which stops everything running in it.
	 */
	async build(job: DesiredBuild, signal: AbortSignal = NEVER): Promise<BuildReport> {
		return cancelled(await this.#build(job, signal), signal);
	}

	async #build(job: DesiredBuild, signal: AbortSignal): Promise<BuildReport> {
		const name = jobContainerName(job.deploymentId);
		const report = (
			state: BuildReport['state'],
			extra: Partial<BuildReport> = {}
		): BuildReport => ({
			deploymentId: job.deploymentId,
			state,
			image: null,
			commit: null,
			error: null,
			scan: null,
			...extra
		});
		const say = (line: string) => this.options.onLine(job.deploymentId, line);
		const work = WORK;
		let commit: string | null = null;
		const stop = this.#stopOnAbort(name, signal);

		try {
			await this.#prepare(name, job.organizationId, signal, job.scan !== 'off', say);
			const run = (cmd: string[], env?: Record<string, string>, stdout?: NodeJS.WritableStream) =>
				this.runtime.execStream(name, cmd, { env, stdout, onLine: (_, line) => say(line) });

			await run(['mkdir', '-p', `${work}/plan`]);

			// 1. source
			say(`Cloning ${job.repo} (${job.commit ?? job.ref})`);
			const output: string[] = [];
			const clone = await this.runtime.execStream(name, ['sh', '-c', CLONE_SCRIPT], {
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
			const scanning = job.scan !== 'off';
			const tarball = `${work}/image.tar`;
			// scanned images are written to a file first, so a blocked image never reaches Docker
			const outputFlags = [
				'--output',
				`type=docker,name=${job.image}${scanning ? `,dest=${tarball}` : ''}`
			];
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

			// 3. build into the local Docker; a scanned image goes through a file first,
			// so one that's refused never reaches Docker
			let scan: ScanResult | null = null;
			if (scanning) {
				if ((await run(buildctl, job.secrets)) !== 0)
					return report('failed', { commit, error: 'The build failed; see the build log' });
				scan = await this.#scan(name, ['--input', tarball], job.scan, work, say);
				if (refused(scan, job.scan))
					return report('failed', { commit, scan, error: refusal(scan) });
				if ((await this.#load((stdout) => run(['cat', tarball], undefined, stdout))) !== 0)
					throw new Error('Could not load the built image');
			} else {
				const built = await this.#load((stdout) => run(buildctl, job.secrets, stdout));
				if (built !== 0)
					return report('failed', { commit, error: 'The build failed; see the build log' });
			}

			if (signal.aborted) throw signal.reason;
			const image = await this.runtime.imageId(job.image);
			if (!image) return report('failed', { commit, error: 'The built image was not found' });
			say(`Built ${image.slice(7, 19)}`);
			await this.#collect(job);
			return report('succeeded', { image, commit, scan });
		} catch (error) {
			return report('failed', { commit, error: failure(error, signal) });
		} finally {
			await stop();
		}
	}

	/**
	 * Pulls a registry image and scans that exact digest before it runs. Trivy
	 * fetches the image from the registry itself, so the builder never needs
	 * access to the Docker socket.
	 */
	async scanImage(job: DesiredScan, signal: AbortSignal = NEVER): Promise<BuildReport> {
		return cancelled(await this.#scanImage(job, signal), signal);
	}

	async #scanImage(job: DesiredScan, signal: AbortSignal): Promise<BuildReport> {
		const name = jobContainerName(job.deploymentId);
		const say = (line: string) => this.options.onLine(job.deploymentId, line);
		const work = WORK;
		const stop = this.#stopOnAbort(name, signal);
		const report = (
			state: BuildReport['state'],
			extra: Partial<BuildReport> = {}
		): BuildReport => ({
			deploymentId: job.deploymentId,
			state,
			image: null,
			commit: null,
			error: null,
			scan: null,
			...extra
		});
		try {
			await this.#prepare(name, SCAN_SCOPE, signal, true, say);
			say(`Pulling ${job.image}`);
			await this.runtime.pull(job.image);
			// the digest pins the deployment to exactly what was scanned
			const digest = await this.runtime.repoDigest(job.image);
			if (!digest) {
				const scan = scanError('the image has no registry digest to scan');
				say(describe(scan));
				return refused(scan, job.scan)
					? report('failed', { scan, error: refusal(scan) })
					: report('succeeded', { image: job.image, scan });
			}
			await this.runtime.execStream(name, ['mkdir', '-p', work], { onLine: () => {} });
			const scan = await this.#scan(name, ['--image-src', 'remote', digest], job.scan, work, say);
			if (signal.aborted) throw signal.reason;
			return refused(scan, job.scan)
				? report('failed', { scan, error: refusal(scan) })
				: report('succeeded', { image: digest, scan });
		} catch (error) {
			return report('failed', { error: failure(error, signal) });
		} finally {
			await stop();
		}
	}

	/** Runs Trivy on an image (a tarball or a registry reference) and summarises its report. */
	async #scan(
		name: string,
		target: string[],
		mode: ScanMode,
		work: string,
		say: (line: string) => void
	) {
		say(`Scanning for vulnerabilities with ${SCANNER}`);
		const output = `${work}/scan.json`;
		const code = await this.runtime.execStream(
			name,
			[
				TRIVY_PATH,
				'image',
				'--scanners',
				'vuln',
				'--format',
				'json',
				'--output',
				output,
				'--cache-dir',
				TRIVY_CACHE,
				'--timeout',
				'15m',
				'--skip-version-check',
				// the layer cache is a locked file; keeping it in memory lets scans run side by side
				'--cache-backend',
				'memory',
				...target
			],
			{
				env: { TRIVY_NO_PROGRESS: 'true', TRIVY_DISABLE_VEX_NOTICE: 'true' },
				onLine: (_, line) => say(line)
			}
		);
		let scan: ScanResult;
		if (code !== 0) {
			scan = scanError(`Trivy exited with code ${code}; see the build log`);
		} else {
			const json = new PassThrough();
			const chunks: Buffer[] = [];
			json.on('data', (chunk: Buffer) => chunks.push(chunk));
			await this.runtime.execStream(name, ['cat', output], { onLine: () => {}, stdout: json });
			try {
				scan = summarise(JSON.parse(Buffer.concat(chunks).toString()) as TrivyReport, mode);
			} catch {
				scan = scanError('Trivy wrote an unreadable report');
			}
		}
		say(describe(scan));
		for (const finding of scan.findings.filter((f) => f.severity === 'critical').slice(0, 10)) {
			say(
				`  ${finding.id} in ${finding.package} ${finding.installed}${finding.fixed ? ` (fixed in ${finding.fixed})` : ''}`
			);
		}
		return scan;
	}

	/**
	 * Streams an image tarball written by a builder command into Docker, and
	 * returns the command's exit code.
	 */
	async #load(produce: (stdout: NodeJS.WritableStream) => Promise<number>) {
		const tarball = new PassThrough();
		const loaded = this.runtime.loadImage(tarball);
		// the exec's output stream ends `tarball` once everything is flushed; ending it here
		// instead would cut off data still buffered for a slower `docker load`
		const code = await produce(tarball);
		await loaded.catch((error) => {
			if (code === 0) throw error;
		});
		return code;
	}

	/** Removes the job's builder when `signal` aborts; the returned function removes it anyway. */
	#stopOnAbort(name: string, signal: AbortSignal) {
		const remove = () => this.runtime.remove(name).catch(() => {});
		signal.addEventListener('abort', remove, { once: true });
		return async () => {
			signal.removeEventListener('abort', remove);
			await remove();
		};
	}

	/**
	 * Starts a fresh builder for one job: rootless BuildKit with its process
	 * sandbox on, so build steps run in containers of their own and can't see
	 * or touch the builder, its tools or another job. The cache volume is the
	 * organization's. Railpack and Trivy are installed on it once per version.
	 */
	async #prepare(
		name: string,
		scope: string,
		signal: AbortSignal,
		scanning: boolean,
		say: (line: string) => void
	) {
		const nodeId = this.options.nodeId();
		if (signal.aborted) throw signal.reason;
		await this.runtime.remove(name);
		if (!(await this.runtime.hasImage(BUILDKIT_IMAGE))) await this.runtime.pull(BUILDKIT_IMAGE);
		await this.runtime.run({
			name,
			image: BUILDKIT_IMAGE,
			env: {},
			network: 'bridge',
			aliases: [],
			restart: { name: 'no', maxRetries: 0 },
			volumes: [{ name: cacheVolume(nodeId, scope), target: BUILDKIT_STATE }],
			// rootless BuildKit runs as uid 1000 and is never --privileged. Its user namespace needs
			// setuid helpers and relaxed seccomp/AppArmor profiles, and its process sandbox needs
			// /proc unmasked (BuildKit's documented way to run rootless with the sandbox)
			security: {
				capabilities: 'docker-default',
				pidsLimit: BUILD_PIDS,
				memoryMb: this.options.memoryMb ?? BUILD_MEMORY_MB,
				readOnlyRootFilesystem: false,
				noNewPrivileges: false,
				unconfined: true,
				unmaskSystemPaths: true
			},
			labels: {
				[LABELS.managed]: 'true',
				[LABELS.node]: nodeId,
				[LABELS.role]: 'build-job'
			}
		});
		const arch = await this.runtime.arch();
		await this.#install(name, RAILPACK_TOOL, RAILPACK_PATH, arch);
		if (scanning) {
			await this.#install(name, TRIVY_TOOL, TRIVY_PATH, arch);
			await this.#updateDatabase(name, say);
		}
		// buildkitd takes a moment to accept connections after the container starts
		for (let attempt = 0; attempt < (this.options.readyAttempts ?? 60); attempt++) {
			if (signal.aborted) throw signal.reason;
			const ready = await this.runtime.execStream(name, ['buildctl', 'debug', 'workers'], {
				onLine: () => {}
			});
			if (ready === 0) return;
			await new Promise((resolve) => setTimeout(resolve, this.options.readyPollMs ?? 500));
		}
		throw new Error('The builder did not start');
	}

	#tool(tool: ReleaseTool, arch: string) {
		return this.options.tools
			? this.options.tools(tool, arch)
			: releaseBinary(tool, this.options.stateDir, arch, this.options.fetcher);
	}

	/** Puts a tool on the cache volume unless this version is already there. */
	async #install(name: string, tool: ReleaseTool, target: string, arch: string) {
		if ((await this.runtime.execStream(name, ['test', '-x', target], { onLine: () => {} })) === 0) {
			return;
		}
		await this.runtime.execStream(name, ['mkdir', '-p', TOOLS], { onLine: () => {} });
		await this.runtime.putFile(name, target, await this.#tool(tool, arch), 0o755);
	}

	/**
	 * Fetches Trivy's vulnerability database when it's missing or stale. A
	 * failure is only logged: the scan then reports what it can.
	 */
	async #updateDatabase(name: string, say: (line: string) => void) {
		const output: string[] = [];
		const code = await this.runtime.execStream(
			name,
			[
				TRIVY_PATH,
				'image',
				'--download-db-only',
				'--cache-dir',
				TRIVY_CACHE,
				'--skip-version-check'
			],
			{ env: { TRIVY_NO_PROGRESS: 'true' }, onLine: (_, line) => output.push(line) }
		);
		if (code !== 0) {
			const reason = output.at(-1) ?? `exit ${code}`;
			say(`Could not update Trivy's vulnerability database: ${reason}`);
			this.options.log?.(`Could not download Trivy's vulnerability database: ${reason}`);
		}
	}

	/** Removes older built images of the service, keeping the newest few. */
	async #collect(job: DesiredBuild) {
		const repository = job.image.split(':')[0]!;
		const images = await this.runtime.listImages(repository);
		for (const image of images.slice(KEEP_IMAGES)) await this.runtime.removeImage(image.id);
	}
}

/** A signal that never aborts, for callers without a deadline. */
const NEVER = new AbortController().signal;

/** A job that was cancelled failed for that reason, whatever step it was on. */
const cancelled = (report: BuildReport, signal: AbortSignal): BuildReport =>
	signal.aborted
		? { ...report, state: 'failed', image: null, error: failure(null, signal) }
		: report;

/** Why a job ended early: the cancellation's reason when it was stopped. */
function failure(error: unknown, signal: AbortSignal) {
	if (signal.aborted) {
		const reason = signal.reason;
		return reason instanceof Error ? reason.message : 'Cancelled';
	}
	return error instanceof Error ? error.message : String(error);
}

/** Whether a scan stops the image from running: always when blocked, and in block mode when the scan failed. */
export const refused = (scan: ScanResult, mode: ScanMode) =>
	scan.outcome === 'blocked' || (mode === 'block' && scan.outcome === 'error');

const refusal = (scan: ScanResult) =>
	scan.outcome === 'blocked'
		? blockedMessage(scan)
		: `Blocked: the image could not be scanned (${scan.error})`;

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
	// an installation token is GitHub's; it is never sent anywhere else
	const origin = new URL(repo).origin;
	if (origin !== 'https://github.com') return env;
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
