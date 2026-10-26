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
import { LABELS, type ContainerRuntime, type ManagedContainer } from './runtime';
import {
	blockedMessage,
	describe,
	scanError,
	SCANNER,
	summarise,
	type TrivyReport
} from './scanner';
import { hash } from './spec';

/** Keep this many built images per service so recent rollbacks don't need a rebuild. */
export const KEEP_IMAGES = 3;

const HOME = '/home/user';
const RAILPACK_PATH = `${HOME}/bin/railpack`;
const TRIVY_PATH = `${HOME}/bin/trivy`;
const BUILDKIT_STATE = `${HOME}/.local/share/buildkit`;
/**
 * Trivy's vulnerability database, kept on the builder's volume so it survives
 * restarts. (A volume of its own would be created root-owned, and the builder
 * runs unprivileged.)
 */
const TRIVY_CACHE = `${BUILDKIT_STATE}/trivy-cache`;

export const builderName = (nodeId: string) => `tramline-builder-${nodeId}`;

export interface BuilderOptions {
	stateDir: string;
	nodeId: () => string;
	/** Build output, line by line, for the deployment's log. */
	onLine: (deploymentId: string, line: string) => void;
	fetcher?: typeof fetch;
	log?: (message: string) => void;
	/** Fetches a verified tool binary; tests pass a fake. */
	tools?: (tool: ReleaseTool, arch: string) => Promise<Buffer>;
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
			scan: null,
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
				scan = await this.#scan(['--input', tarball], job.scan, work, say);
				if (refused(scan, job.scan))
					return report('failed', { commit, scan, error: refusal(scan) });
				if ((await this.#load((stdout) => run(['cat', tarball], undefined, stdout))) !== 0)
					throw new Error('Could not load the built image');
			} else {
				const built = await this.#load((stdout) => run(buildctl, job.secrets, stdout));
				if (built !== 0)
					return report('failed', { commit, error: 'The build failed; see the build log' });
			}

			const image = await this.runtime.imageId(job.image);
			if (!image) return report('failed', { commit, error: 'The built image was not found' });
			say(`Built ${image.slice(7, 19)}`);
			await this.#collect(job);
			return report('succeeded', { image, commit, scan });
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

	/**
	 * Pulls a registry image and scans that exact digest before it runs. Trivy
	 * fetches the image from the registry itself, so the builder never needs
	 * access to the Docker socket.
	 */
	async scanImage(job: DesiredScan): Promise<BuildReport> {
		const say = (line: string) => this.options.onLine(job.deploymentId, line);
		const work = `${HOME}/work/${job.deploymentId}`;
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
			await this.ensure();
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
			await this.runtime.execStream(this.name, ['mkdir', '-p', work], { onLine: () => {} });
			const scan = await this.#scan(['--image-src', 'remote', digest], job.scan, work, say);
			return refused(scan, job.scan)
				? report('failed', { scan, error: refusal(scan) })
				: report('succeeded', { image: digest, scan });
		} catch (error) {
			return report('failed', { error: error instanceof Error ? error.message : String(error) });
		} finally {
			await this.runtime
				.execStream(this.name, ['rm', '-rf', work], { onLine: () => {} })
				.catch(() => {});
		}
	}

	/** Runs Trivy on an image (a tarball or a registry reference) and summarises its report. */
	async #scan(target: string[], mode: ScanMode, work: string, say: (line: string) => void) {
		say(`Scanning for vulnerabilities with ${SCANNER}`);
		const output = `${work}/scan.json`;
		const code = await this.runtime.execStream(
			this.name,
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
			await this.runtime.execStream(this.name, ['cat', output], { onLine: () => {}, stdout: json });
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

	/** Starts the builder container and installs Railpack and Trivy in it, once. */
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
			volumes: [{ name: `tramline-buildkit-${nodeId}`, target: BUILDKIT_STATE }],
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

		const binary = await this.#tool(RAILPACK_TOOL, await this.runtime.arch());
		await this.runtime.execStream(this.name, ['mkdir', '-p', path.posix.dirname(RAILPACK_PATH)], {
			onLine: () => {}
		});
		await this.runtime.putFile(this.name, RAILPACK_PATH, binary, 0o755);
		await this.#installTrivy();
		await this.#updateDatabase();
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

	#tool(tool: ReleaseTool, arch: string) {
		return this.options.tools
			? this.options.tools(tool, arch)
			: releaseBinary(tool, this.options.stateDir, arch, this.options.fetcher);
	}

	/** Copies Trivy into the builder unless this version is already there (it's large). */
	async #installTrivy() {
		let installed = '';
		await this.runtime.execStream(this.name, [TRIVY_PATH, '--version'], {
			onLine: (_, line) => (installed += `${line}\n`)
		});
		if (installed.includes(`Version: ${TRIVY.version}`)) return;
		const binary = await this.#tool(TRIVY_TOOL, await this.runtime.arch());
		await this.runtime.putFile(this.name, TRIVY_PATH, binary, 0o755);
	}

	/**
	 * Fetches Trivy's vulnerability database (when it is missing or stale) once
	 * the builder starts, so concurrent scans don't each try to download it.
	 * A failure is only logged: the next scan tries again.
	 */
	async #updateDatabase() {
		const output: string[] = [];
		const code = await this.runtime.execStream(
			this.name,
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
			this.options.log?.(
				`Could not download Trivy's vulnerability database: ${output.at(-1) ?? `exit ${code}`}`
			);
		}
	}

	/** Removes older built images of the service, keeping the newest few. */
	async #collect(job: DesiredBuild) {
		const repository = job.image.split(':')[0]!;
		const images = await this.runtime.listImages(repository);
		for (const image of images.slice(KEEP_IMAGES)) await this.runtime.removeImage(image.id);
	}
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
