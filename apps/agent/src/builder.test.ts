import { createHash } from 'node:crypto';
import type { DesiredBuild } from '@tramline/contracts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';
import { describe, expect, it, vi } from 'vitest';
import {
	Builder,
	cacheVolume,
	CLONE_SCRIPT,
	jobContainerName,
	gitAuth,
	safeSubdirectory,
	secretsHash
} from './builder';
import { BUILDKIT_IMAGE, RAILPACK, TRIVY } from './pins';
import {
	extractFile,
	railpackBinary,
	releaseBinary,
	TRIVY_TOOL,
	type ReleaseTool
} from './railpack';
import { FakeRuntime, fakeTools, stateDirWithTools } from './testing';

const COMMIT = 'a'.repeat(40);

/** `buildctl`, or a versioned tool on the cache volume like `…/railpack-v0.43.0`. */
const isTool = (path: string, name: string) =>
	path === name || (path.split('/').at(-1) ?? '').startsWith(`${name}-`);

function job(overrides: Partial<DesiredBuild> = {}): DesiredBuild {
	return {
		deploymentId: 'dep_1',
		serviceId: 'svc_1',
		organizationId: 'org_1',
		repo: 'https://github.com/acme/api',
		ref: 'main',
		commit: null,
		token: null,
		rootDirectory: '/',
		builder: 'railpack',
		dockerfilePath: null,
		buildCommand: null,
		startCommand: null,
		image: 'tramline/svc_1:dep_1',
		secrets: { NPM_TOKEN: 'npm_secret_value', PORT: '8080' },
		scan: 'off',
		...overrides
	};
}

/** A builder whose fake runtime behaves like a successful build unless told otherwise. */
function setup(options: { dockerfile?: boolean; fail?: string; prepareExit?: number[] } = {}) {
	const runtime = new FakeRuntime();
	// cached tool binaries, so tests don't download
	const stateDir = stateDirWithTools();
	const prepareExits = [...(options.prepareExit ?? [0])];
	runtime.onExec = (cmd, { onLine }) => {
		const program = cmd[0]!;
		if (program === 'sh') {
			if (options.fail === 'clone') return 128;
			onLine('stdout', COMMIT);
			return 0;
		}
		// tools aren't on the cache volume yet
		if (program === 'test' && cmd[1] === '-x') return 1;
		if (program === 'test') return options.dockerfile ? 0 : 1;
		if (isTool(program, 'railpack')) {
			onLine('stdout', '↳ Detected Node');
			return prepareExits.shift() ?? 0;
		}
		if (program === 'buildctl' && cmd[1] === 'build') {
			if (options.fail === 'build') return 1;
			runtime.images.set('tramline/svc_1:dep_1', { id: 'sha256:built000000000000', created: 100 });
			return 0;
		}
		return 0;
	};
	const lines: string[] = [];
	const builder = new Builder(runtime, {
		stateDir,
		tools: fakeTools,
		nodeId: () => 'node_1',
		onLine: (_, line) => lines.push(line),
		readyPollMs: 1
	});
	return { runtime, builder, lines, stateDir };
}

const execOf = (runtime: FakeRuntime, program: string, sub?: string) =>
	runtime.execs.find((e) => isTool(e.cmd[0]!, program) && (!sub || e.cmd[1] === sub));

describe('Builder', () => {
	it('clones, plans with Railpack and builds with secrets kept out of the command line', async () => {
		const { runtime, builder, lines } = setup();
		const result = await builder.build(job());
		expect(result).toEqual({
			deploymentId: 'dep_1',
			state: 'succeeded',
			image: 'sha256:built000000000000',
			commit: COMMIT,
			error: null,
			scan: null
		});

		const clone = execOf(runtime, 'sh')!;
		expect(clone.cmd).toEqual(['sh', '-c', CLONE_SCRIPT]);
		expect(clone.env).toMatchObject({
			REPO: 'https://github.com/acme/api',
			REF: 'main',
			GIT_TERMINAL_PROMPT: '0'
		});
		expect(clone.env).not.toHaveProperty('GIT_CONFIG_COUNT');

		const prepare = execOf(runtime, 'railpack')!;
		expect(prepare.cmd).toEqual(
			expect.arrayContaining([
				'prepare',
				'/home/user/work/src',
				'--env',
				'NPM_TOKEN=npm_secret_value'
			])
		);

		const build = execOf(runtime, 'buildctl', 'build')!;
		expect(build.cmd).toEqual(
			expect.arrayContaining([
				'--frontend=gateway.v0',
				`source=${RAILPACK.frontend}`,
				'build-arg:cache-key=svc_1',
				`build-arg:secrets-hash=${secretsHash(job().secrets)}`,
				'--secret',
				'id=NPM_TOKEN,env=NPM_TOKEN',
				'type=docker,name=tramline/svc_1:dep_1'
			])
		);
		// values only travel in the build process's environment
		expect(build.cmd.join(' ')).not.toContain('npm_secret_value');
		expect(build.env).toEqual(job().secrets);

		expect(lines).toEqual(
			expect.arrayContaining([
				`Checked out ${COMMIT.slice(0, 7)}`,
				`Building with Railpack ${RAILPACK.version}`,
				'↳ Detected Node'
			])
		);
		expect(lines.join('\n')).not.toContain('npm_secret_value');
		// the job's builder is thrown away, with everything in it
		expect(runtime.containers.has(jobContainerName('dep_1'))).toBe(false);
		expect(runtime.calls.at(-1)).toBe(`remove ${jobContainerName('dep_1')}`);
	});

	it('uses a Dockerfile when the repository has one, or when asked to', async () => {
		const { runtime, builder } = setup({ dockerfile: true });
		await builder.build(job({ rootDirectory: 'services/api' }));
		expect(execOf(runtime, 'railpack')).toBeUndefined();
		expect(execOf(runtime, 'buildctl', 'build')!.cmd).toEqual(
			expect.arrayContaining([
				'--frontend=dockerfile.v0',
				'context=/home/user/work/src/services/api',
				'dockerfile=/home/user/work/src/services/api',
				'filename=Dockerfile'
			])
		);

		const explicit = setup();
		await explicit.builder.build(
			job({ builder: 'dockerfile', dockerfilePath: 'docker/prod.Dockerfile' })
		);
		expect(execOf(explicit.runtime, 'buildctl', 'build')!.cmd).toEqual(
			expect.arrayContaining(['dockerfile=/home/user/work/src/docker', 'filename=prod.Dockerfile'])
		);
	});

	it('authenticates private clones through git config in the environment', async () => {
		const { runtime, builder } = setup();
		await builder.build(job({ token: 'ghs_installation', commit: 'b'.repeat(40) }));
		const clone = execOf(runtime, 'sh')!;
		expect(clone.env).toMatchObject({
			REF: 'b'.repeat(40),
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
			GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_installation').toString('base64')}`
		});
		expect(clone.env!.REPO).toBe('https://github.com/acme/api');
	});

	it('reports failures at each step', async () => {
		expect(await setup({ fail: 'clone' }).builder.build(job())).toMatchObject({
			state: 'failed',
			error: 'Could not fetch main from https://github.com/acme/api'
		});
		expect(await setup({ prepareExit: [1] }).builder.build(job())).toMatchObject({
			state: 'failed',
			commit: COMMIT,
			error: 'Railpack could not plan this app'
		});
		expect(await setup({ fail: 'build' }).builder.build(job())).toMatchObject({
			state: 'failed',
			error: 'The build failed; see the build log'
		});
	});

	it('retries a transient Railpack failure once', async () => {
		const { runtime, builder } = setup({ prepareExit: [75, 0] });
		expect((await builder.build(job())).state).toBe('succeeded');
		expect(runtime.execs.filter((e) => isTool(e.cmd[0]!, 'railpack'))).toHaveLength(2);
	});

	it('keeps only the newest built images of a service', async () => {
		const { runtime, builder } = setup();
		for (let i = 0; i < 4; i++)
			runtime.images.set(`tramline/svc_1:old${i}`, { id: `sha256:old${i}`, created: i });
		await builder.build(job());
		expect(runtime.calls.filter((c) => c.startsWith('rmi'))).toEqual([
			'rmi sha256:old1',
			'rmi sha256:old0'
		]);
	});

	it('runs each build in a sandboxed builder of its own, on its organization’s cache', async () => {
		const { runtime, builder } = setup();
		const started: unknown[] = [];
		const run = runtime.run.bind(runtime);
		runtime.run = async (spec) => {
			started.push(spec);
			await run(spec);
		};
		await builder.build(job());
		await builder.build(job({ deploymentId: 'dep_2', organizationId: 'org_2' }));
		expect(started).toEqual([
			expect.objectContaining({
				name: jobContainerName('dep_1'),
				image: BUILDKIT_IMAGE,
				// no --oci-worker-no-process-sandbox: build steps run in sandboxes of their own
				volumes: [
					{ name: cacheVolume('node_1', 'org_1'), target: '/home/user/.local/share/buildkit' }
				],
				security: expect.objectContaining({
					noNewPrivileges: false,
					unconfined: true,
					unmaskSystemPaths: true,
					memoryMb: 4096,
					pidsLimit: 4096
				}),
				labels: expect.objectContaining({ 'tramline.role': 'build-job', 'tramline.node': 'node_1' })
			}),
			expect.objectContaining({
				name: jobContainerName('dep_2'),
				volumes: [
					{ name: cacheVolume('node_1', 'org_2'), target: '/home/user/.local/share/buildkit' }
				]
			})
		]);
		expect((started[0] as { cmd?: string[] }).cmd).toBeUndefined();
		expect((started[0] as { binds?: string[] }).binds).toBeUndefined();
		// Railpack goes on the cache volume, under its version
		expect(
			runtime.files
				.get(
					`${jobContainerName('dep_1')}:/home/user/.local/share/buildkit/tools/railpack-${RAILPACK.version}`
				)
				?.toString()
		).toBe('binary');
	});

	it('stops a build when it is cancelled: its builder goes, and so does everything in it', async () => {
		const { runtime, builder } = setup();
		const controller = new AbortController();
		const base = runtime.onExec;
		runtime.onExec = (cmd, options) => {
			if (cmd[0] === 'buildctl' && cmd[1] === 'build') {
				controller.abort(new Error('Timed out after 30 minutes'));
				return 137;
			}
			return base(cmd, options);
		};
		expect(await builder.build(job(), controller.signal)).toMatchObject({
			state: 'failed',
			error: 'Timed out after 30 minutes'
		});
		expect(runtime.containers.has(jobContainerName('dep_1'))).toBe(false);

		// cancelled before it starts: nothing runs
		runtime.calls = [];
		const early = new AbortController();
		early.abort(new Error('No longer wanted'));
		expect(await builder.build(job(), early.signal)).toMatchObject({
			state: 'failed',
			error: 'No longer wanted'
		});
		expect(runtime.calls.some((c) => c.startsWith('run '))).toBe(false);
	});

	it('clears out builders a previous run left behind', async () => {
		const { runtime, builder } = setup();
		for (const [name, role, nodeId] of [
			['tl-build-dep_old', 'build-job', 'node_1'],
			['tramline-builder-node_1', 'builder', 'node_1'],
			['tl-build-other', 'build-job', 'node_2'],
			['tl-dep_1-0', 'workload', 'node_1']
		] as const) {
			await runtime.run({
				name,
				image: 'x',
				env: {},
				network: 'bridge',
				aliases: [],
				restart: { name: 'no', maxRetries: 0 },
				security: { capabilities: [], pidsLimit: 1, memoryMb: null, readOnlyRootFilesystem: false },
				labels: { 'tramline.managed': 'true', 'tramline.role': role, 'tramline.node': nodeId }
			});
		}
		await builder.reap();
		expect([...runtime.containers.keys()].sort()).toEqual(['tl-build-other', 'tl-dep_1-0']);
	});
});

describe('Builder recovery', () => {
	it('waits for BuildKit to accept connections, and gives up eventually', async () => {
		const { runtime, builder } = setup();
		let checks = 0;
		const base = runtime.onExec;
		runtime.onExec = (cmd, options) =>
			cmd[0] === 'buildctl' && cmd[1] === 'debug' ? (++checks < 3 ? 1 : 0) : base(cmd, options);
		expect((await builder.build(job())).state).toBe('succeeded');
		expect(checks).toBe(3);

		runtime.onExec = (cmd, options) =>
			cmd[0] === 'buildctl' && cmd[1] === 'debug' ? 1 : base(cmd, options);
		expect(await builder.build(job())).toMatchObject({
			state: 'failed',
			error: 'The builder did not start'
		});
	});

	it('reports Docker being unavailable', async () => {
		const { runtime, builder } = setup();
		runtime.down = true;
		expect((await builder.build(job())).error).toMatch('ENOENT');
	});

	it('fails the build when the image cannot be loaded', async () => {
		const { runtime, builder } = setup();
		runtime.loadImage = async () => {
			throw new Error('invalid tar header');
		};
		expect(await builder.build(job())).toMatchObject({
			state: 'failed',
			error: 'invalid tar header'
		});
	});

	it('fails the build when the image does not show up', async () => {
		const { runtime, builder } = setup();
		const base = runtime.onExec;
		runtime.onExec = (cmd, options) =>
			cmd[0] === 'buildctl' && cmd[1] === 'build' ? 0 : base(cmd, options);
		expect(await builder.build(job())).toMatchObject({
			state: 'failed',
			error: 'The built image was not found'
		});
	});
});

describe('helpers', () => {
	it('keeps root directories inside the repository', () => {
		expect(safeSubdirectory('/')).toBe('');
		expect(safeSubdirectory('apps/web/')).toBe('apps/web/');
		expect(safeSubdirectory('/apps/../web')).toBe('web');
		// `..` past the root stays at the root of the clone
		expect(safeSubdirectory('../../etc')).toBe('etc');
		expect(safeSubdirectory('a/../../..')).toBe('');
	});

	it('only adds credentials for GitHub over HTTPS, and only with a token', () => {
		expect(gitAuth('https://github.com/a/b', null)).toEqual({ GIT_TERMINAL_PROMPT: '0' });
		expect(gitAuth('https://github.com/a/b', 't').GIT_CONFIG_KEY_0).toBe(
			'http.https://github.com/.extraheader'
		);
		// an installation token is never sent to any other origin
		for (const repo of [
			'https://attacker.example/a/b',
			'http://github.com/a/b',
			'https://github.com.attacker.example/a/b'
		]) {
			expect(gitAuth(repo, 't')).toEqual({ GIT_TERMINAL_PROMPT: '0' });
		}
	});

	it('changes the secrets hash when any value changes, regardless of order', () => {
		expect(secretsHash({ A: '1', B: '2' })).toBe(secretsHash({ B: '2', A: '1' }));
		expect(secretsHash({ A: '1' })).not.toBe(secretsHash({ A: '2' }));
	});
});

describe('railpackBinary', () => {
	async function tarball(files: Record<string, string>) {
		const archive = pack();
		for (const [name, content] of Object.entries(files)) archive.entry({ name }, content);
		archive.finalize();
		const chunks: Buffer[] = [];
		for await (const chunk of archive) chunks.push(chunk as Buffer);
		return gzipSync(Buffer.concat(chunks));
	}

	it('extracts the CLI from a release tarball', async () => {
		expect(
			(
				await extractFile(await tarball({ 'README.md': 'x', railpack: 'cli' }), 'railpack')
			).toString()
		).toBe('cli');
		await expect(extractFile(await tarball({ other: 'x' }), 'railpack')).rejects.toThrow(
			'not found'
		);
	});

	it('refuses a download whose checksum does not match the pin', async () => {
		const stateDir = mkdtempSync(path.join(tmpdir(), 'tramline-rp-'));
		const body = await tarball({ railpack: 'tampered' });
		const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
		await expect(railpackBinary(stateDir, 'x86_64', fetcher)).rejects.toThrow('Checksum mismatch');
		expect(String(fetcher.mock.calls[0]![0])).toBe(
			`https://github.com/railwayapp/railpack/releases/download/${RAILPACK.version}/railpack-${RAILPACK.version}-x86_64-unknown-linux-musl.tar.gz`
		);
		await expect(railpackBinary(stateDir, 'riscv64', fetcher)).rejects.toThrow(
			'no build for riscv64'
		);
		await expect(
			railpackBinary(stateDir, 'x86_64', async () => new Response('nope', { status: 404 }))
		).rejects.toThrow('HTTP 404');
	});
	it('downloads Trivy from its official release for each architecture', () => {
		expect(TRIVY_TOOL.url('aarch64')).toBe(
			`https://github.com/aquasecurity/trivy/releases/download/v${TRIVY.version}/trivy_${TRIVY.version}_Linux-ARM64.tar.gz`
		);
		expect(TRIVY_TOOL.url('riscv64')).toBeNull();
	});

	it('keeps the verified release, and fetches it again if the cached copy was altered', async () => {
		const stateDir = mkdtempSync(path.join(tmpdir(), 'tramline-rp-'));
		const body = await tarball({ tool: 'real' });
		const tool: ReleaseTool = {
			name: 'tool',
			version: 'v1',
			sha256: { x86_64: createHash('sha256').update(body).digest('hex') },
			url: () => 'https://example.test/tool-v1.tar.gz'
		};
		const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
		expect((await releaseBinary(tool, stateDir, 'x86_64', fetcher)).toString()).toBe('real');
		expect((await releaseBinary(tool, stateDir, 'x86_64', fetcher)).toString()).toBe('real');
		expect(fetcher).toHaveBeenCalledTimes(1);

		writeFileSync(path.join(stateDir, 'tool', 'v1', 'x86_64', 'tool-v1.tar.gz'), 'tampered');
		expect((await releaseBinary(tool, stateDir, 'x86_64', fetcher)).toString()).toBe('real');
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
