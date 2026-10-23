import type { DesiredBuild } from '@tramline/contracts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';
import { describe, expect, it, vi } from 'vitest';
import {
	Builder,
	builderName,
	CLONE_SCRIPT,
	gitAuth,
	safeSubdirectory,
	secretsHash
} from './builder';
import { BUILDKIT_IMAGE, RAILPACK } from './pins';
import { extractFile, railpackBinary } from './railpack';
import { FakeRuntime } from './testing';

const COMMIT = 'a'.repeat(40);

function job(overrides: Partial<DesiredBuild> = {}): DesiredBuild {
	return {
		deploymentId: 'dep_1',
		serviceId: 'svc_1',
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
		...overrides
	};
}

/** A builder whose fake runtime behaves like a successful build unless told otherwise. */
function setup(options: { dockerfile?: boolean; fail?: string; prepareExit?: number[] } = {}) {
	const runtime = new FakeRuntime();
	const stateDir = mkdtempSync(path.join(tmpdir(), 'tramline-builder-'));
	// a cached Railpack binary, so tests don't download
	const cached = path.join(stateDir, 'railpack', RAILPACK.version, 'aarch64');
	mkdirSync(cached, { recursive: true });
	writeFileSync(path.join(cached, 'railpack'), 'binary');
	const prepareExits = [...(options.prepareExit ?? [0])];
	runtime.onExec = (cmd, { onLine }) => {
		const program = cmd[0]!;
		if (program === 'sh') {
			if (options.fail === 'clone') return 128;
			onLine('stdout', COMMIT);
			return 0;
		}
		if (program === 'test') return options.dockerfile ? 0 : 1;
		if (program.endsWith('railpack')) {
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
		nodeId: () => 'node_1',
		onLine: (_, line) => lines.push(line)
	});
	return { runtime, builder, lines, stateDir };
}

const execOf = (runtime: FakeRuntime, program: string, sub?: string) =>
	runtime.execs.find((e) => e.cmd[0]!.endsWith(program) && (!sub || e.cmd[1] === sub));

describe('Builder', () => {
	it('clones, plans with Railpack and builds with secrets kept out of the command line', async () => {
		const { runtime, builder, lines } = setup();
		const result = await builder.build(job());
		expect(result).toEqual({
			deploymentId: 'dep_1',
			state: 'succeeded',
			image: 'sha256:built000000000000',
			commit: COMMIT,
			error: null
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
				'/home/user/work/dep_1/src',
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
		// the work directory is cleaned up
		expect(runtime.execs.at(-1)!.cmd).toEqual(['rm', '-rf', '/home/user/work/dep_1']);
	});

	it('uses a Dockerfile when the repository has one, or when asked to', async () => {
		const { runtime, builder } = setup({ dockerfile: true });
		await builder.build(job({ rootDirectory: 'services/api' }));
		expect(execOf(runtime, 'railpack')).toBeUndefined();
		expect(execOf(runtime, 'buildctl', 'build')!.cmd).toEqual(
			expect.arrayContaining([
				'--frontend=dockerfile.v0',
				'context=/home/user/work/dep_1/src/services/api',
				'dockerfile=/home/user/work/dep_1/src/services/api',
				'filename=Dockerfile'
			])
		);

		const explicit = setup();
		await explicit.builder.build(
			job({ builder: 'dockerfile', dockerfilePath: 'docker/prod.Dockerfile' })
		);
		expect(execOf(explicit.runtime, 'buildctl', 'build')!.cmd).toEqual(
			expect.arrayContaining([
				'dockerfile=/home/user/work/dep_1/src/docker',
				'filename=prod.Dockerfile'
			])
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
		expect(runtime.execs.filter((e) => e.cmd[0]!.endsWith('railpack'))).toHaveLength(2);
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

	it('runs rootless BuildKit unprivileged, with Railpack installed', async () => {
		const { runtime, builder } = setup();
		await builder.ensure();
		const container = runtime.containers.get(builderName('node_1'))!;
		expect(container.spec).toMatchObject({
			image: BUILDKIT_IMAGE,
			cmd: ['--oci-worker-no-process-sandbox'],
			volumes: [{ name: 'tramline-buildkit-node_1', target: '/home/user/.local/share/buildkit' }],
			security: { noNewPrivileges: false, unconfined: true, capabilities: 'docker-default' },
			labels: { 'tramline.role': 'builder', 'tramline.node': 'node_1' }
		});
		expect(container.spec.binds).toBeUndefined();
		expect(runtime.files.get(`${builderName('node_1')}:/home/user/bin/railpack`)?.toString()).toBe(
			'binary'
		);
		// a second call reuses it
		runtime.calls = [];
		await builder.ensure();
		expect(runtime.calls).toEqual([]);
	});
});

describe('Builder recovery', () => {
	it('waits for BuildKit to accept connections', async () => {
		const { runtime, builder } = setup();
		let checks = 0;
		const base = runtime.onExec;
		runtime.onExec = (cmd, options) =>
			cmd[0] === 'buildctl' && cmd[1] === 'debug' ? (++checks < 3 ? 1 : 0) : base(cmd, options);
		await builder.ensure();
		expect(checks).toBe(3);
	});

	it('retries starting the builder after a failure', async () => {
		const { runtime, builder } = setup();
		runtime.down = true;
		await expect(builder.ensure()).rejects.toThrow('ENOENT');
		runtime.down = false;
		await builder.ensure();
		expect(runtime.containers.has(builderName('node_1'))).toBe(true);
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

	it('only adds credentials when there is a token', () => {
		expect(gitAuth('https://github.com/a/b', null)).toEqual({ GIT_TERMINAL_PROMPT: '0' });
		expect(gitAuth('https://gitlab.example.com/a/b', 't').GIT_CONFIG_KEY_0).toBe(
			'http.https://gitlab.example.com/.extraheader'
		);
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
});
