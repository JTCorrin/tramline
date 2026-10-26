import type { DesiredBackup, DesiredRestore } from '@tramline/contracts';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { extract } from 'tar-stream';
import { describe, expect, it, vi } from 'vitest';
import { Backups, decryptFile, DUMP, encrypt, guarded, LOAD, MAGIC } from './backups';
import type { DesiredDrill } from '@tramline/contracts';
import { pack } from 'tar-stream';
import { HELPER_IMAGE } from './pins';
import { LABELS } from './runtime';
import { FakeRuntime } from './testing';

const KEY = randomBytes(32).toString('base64');

async function encrypted(plaintext: Buffer, key = KEY) {
	const chunks: Buffer[] = [];
	await pipeline(Readable.from([plaintext]), encrypt(key), async function* (source) {
		for await (const chunk of source) chunks.push(chunk as Buffer);
	});
	return Buffer.concat(chunks);
}

async function decrypted(ciphertext: Buffer, key = KEY) {
	const dir = mkdtempSync(path.join(tmpdir(), 'tramline-bk-'));
	writeFileSync(path.join(dir, 'in'), ciphertext);
	await decryptFile(path.join(dir, 'in'), path.join(dir, 'out'), key);
	return readFileSync(path.join(dir, 'out'));
}

function setup() {
	const runtime = new FakeRuntime();
	const uploads: { url: string; body: Buffer; headers: Headers }[] = [];
	let download: Buffer = Buffer.alloc(0);
	const fetcher = vi.fn<typeof fetch>(async (input, init) => {
		if (init?.method === 'PUT') {
			const chunks: Buffer[] = [];
			for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>)
				chunks.push(Buffer.from(chunk));
			uploads.push({
				url: String(input),
				body: Buffer.concat(chunks),
				headers: new Headers(init.headers)
			});
			return new Response(null, { status: 200 });
		}
		return new Response(new Uint8Array(download));
	});
	const held = new Set<string>();
	const released: string[][] = [];
	const backups = new Backups(runtime, {
		stateDir: mkdtempSync(path.join(tmpdir(), 'tramline-agent-')),
		nodeId: () => 'node_1',
		hold: (names) => names.forEach((n) => held.add(n)),
		release: (names) => {
			names.forEach((n) => held.delete(n));
			released.push(names);
		},
		fetcher
	});
	return {
		runtime,
		backups,
		fetcher,
		uploads,
		held,
		released,
		serve: (body: Buffer) => (download = body)
	};
}

const backupJob = (overrides: Partial<DesiredBackup> = {}): DesiredBackup => ({
	id: 'bak_1',
	kind: 'postgres',
	container: 'tl-dep_1-0',
	volume: 'tl-vol_1',
	url: 'https://bucket.example/bak_1?X-Amz-Signature=abc',
	key: KEY,
	...overrides
});

const restoreJob = (overrides: Partial<DesiredRestore> = {}): DesiredRestore => ({
	id: 'rst_1',
	kind: 'postgres',
	container: 'tl-dep_1-0',
	stop: [],
	volume: 'tl-vol_1',
	url: 'https://bucket.example/bak_1?X-Amz-Signature=def',
	key: KEY,
	...overrides
});

describe('backup encryption', () => {
	it('round-trips, and refuses altered files and wrong keys', async () => {
		const plaintext = randomBytes(100_000);
		const ciphertext = await encrypted(plaintext);
		expect(ciphertext.subarray(0, 4)).toEqual(MAGIC);
		expect(await decrypted(ciphertext)).toEqual(plaintext);

		const altered = Buffer.from(ciphertext);
		altered[500]! ^= 1;
		await expect(decrypted(altered)).rejects.toThrow('failed its integrity check');
		await expect(decrypted(ciphertext, randomBytes(32).toString('base64'))).rejects.toThrow(
			'failed its integrity check'
		);
		await expect(decrypted(Buffer.from('nope'))).rejects.toThrow('truncated');
		await expect(decrypted(Buffer.alloc(64))).rejects.toThrow('Not a Tramline backup');
		// an empty backup still has a header and a tag
		expect(await decrypted(await encrypted(Buffer.alloc(0)))).toEqual(Buffer.alloc(0));
	});
});

describe('Backups.backup', () => {
	it('dumps a database inside its container, encrypts it and uploads it', async () => {
		const { runtime, backups, uploads } = setup();
		runtime.onExec = (cmd, { stdout }) => {
			stdout!.write(gzipSync('-- dump'));
			return 0;
		};
		const result = await backups.backup(backupJob());
		expect(result).toEqual({
			id: 'bak_1',
			state: 'succeeded',
			size: uploads[0]!.body.length,
			error: null,
			detail: null
		});
		expect(runtime.execs[0]).toMatchObject({
			container: 'tl-dep_1-0',
			cmd: ['sh', '-c', DUMP.postgres]
		});
		// the password stays in the container's environment, never on the command line
		expect(DUMP.postgres).not.toMatch(/PASSWORD/);
		expect(uploads[0]!.url).toBe(backupJob().url);
		expect(uploads[0]!.headers.get('content-length')).toBe(String(uploads[0]!.body.length));
		expect(gunzipSync(await decrypted(uploads[0]!.body)).toString()).toBe('-- dump');
	});

	it('archives other volumes from a locked-down helper container', async () => {
		const { runtime, backups, uploads } = setup();
		runtime.onExec = (cmd, { stdout }) => {
			if (cmd[0] === 'tar') stdout!.write('tar bytes');
			return 0;
		};
		const result = await backups.backup(backupJob({ kind: 'volume', container: null }));
		expect(result.state).toBe('succeeded');
		const helper = runtime.calls.find((c) => c.startsWith('run tl-helper-bak_1'));
		expect(helper).toBeDefined();
		expect(runtime.calls).toContain(`pull ${HELPER_IMAGE}`);
		expect(runtime.execs[0]).toMatchObject({
			container: 'tl-helper-bak_1',
			cmd: ['tar', '-c', '-C', '/data', '.']
		});
		expect(gunzipSync(await decrypted(uploads[0]!.body)).toString()).toBe('tar bytes');
		// removed afterwards
		expect(runtime.containers.has('tl-helper-bak_1')).toBe(false);
	});

	it('gives the helper no network and read-only access to the volume', async () => {
		const { runtime, backups } = setup();
		let spec: unknown;
		const run = runtime.run.bind(runtime);
		runtime.run = async (s) => {
			spec = s;
			return run(s);
		};
		await backups.backup(backupJob({ kind: 'volume', container: null }));
		expect(spec).toMatchObject({
			image: HELPER_IMAGE,
			network: 'none',
			volumes: [{ name: 'tl-vol_1', target: '/data', readOnly: true }],
			security: { capabilities: ['DAC_READ_SEARCH'], readOnlyRootFilesystem: true },
			labels: { [LABELS.role]: 'helper', [LABELS.node]: 'node_1' }
		});
	});

	it('reports failures: no URL, a failed dump, a stopped database, a failed upload', async () => {
		const { runtime, backups, fetcher } = setup();
		expect(await backups.backup(backupJob({ url: null }))).toMatchObject({
			state: 'failed',
			error: 'No upload URL for this backup'
		});

		runtime.onExec = (_cmd, { onLine }) => {
			onLine('stderr', 'pg_dumpall: error: connection refused');
			return 1;
		};
		expect(await backups.backup(backupJob())).toMatchObject({
			state: 'failed',
			error: 'pg_dumpall: error: connection refused'
		});

		expect(await backups.backup(backupJob({ container: null }))).toMatchObject({
			state: 'failed',
			error: 'The database is not running'
		});

		runtime.onExec = () => 0;
		fetcher.mockResolvedValueOnce(new Response('AccessDenied', { status: 403 }));
		expect(await backups.backup(backupJob())).toMatchObject({
			state: 'failed',
			error: 'Upload failed: HTTP 403 AccessDenied'
		});
	});
});

describe('Backups.restore', () => {
	async function entries(archive: Buffer) {
		const files = new Map<string, Buffer>();
		const tar = extract();
		tar.on('entry', (header, stream, next) => {
			const chunks: Buffer[] = [];
			stream.on('data', (c: unknown) => chunks.push(c as Buffer));
			stream.on('end', () => {
				files.set(header.name, Buffer.concat(chunks));
				next();
			});
		});
		await pipeline(Readable.from([archive]), tar);
		return files;
	}

	it('loads a dump into the running database', async () => {
		const { runtime, backups, serve } = setup();
		const dump = gzipSync('-- dump');
		serve(await encrypted(dump));
		const result = await backups.restore(restoreJob());
		expect(result).toMatchObject({ id: 'rst_1', state: 'succeeded' });

		const copied = await entries(runtime.archives.get('tl-dep_1-0:/tmp')!);
		expect(copied.get('tramline-restore-rst_1.gz')).toEqual(dump);
		const load = runtime.execs.find((e) => e.cmd[0] === 'sh')!;
		expect(load).toMatchObject({
			container: 'tl-dep_1-0',
			cmd: ['sh', '-c', LOAD.postgres],
			env: { FILE: '/tmp/tramline-restore-rst_1.gz' }
		});
		// connected apps can't stop the old database from being dropped
		expect(LOAD.postgres).toContain('WITH (FORCE)');
		expect(runtime.execs.at(-1)!.cmd).toEqual(['rm', '-f', '/tmp/tramline-restore-rst_1.gz']);
	});

	it('replaces a volume while its containers are held stopped', async () => {
		const { runtime, backups, serve, held, released } = setup();
		await runtime.run({
			name: 'tl-dep_1-0',
			image: 'redis:7',
			env: {},
			network: 'tl-env_1',
			aliases: [],
			restart: { name: 'always', maxRetries: 0 },
			labels: {},
			security: { capabilities: [], pidsLimit: 1, memoryMb: null, readOnlyRootFilesystem: false }
		});
		const archive = gzipSync('tar bytes');
		serve(await encrypted(archive));
		runtime.onExec = (cmd) => {
			// held while the volume is replaced
			if (cmd[0] === 'find') expect(held).toEqual(new Set(['tl-dep_1-0']));
			return 0;
		};
		const result = await backups.restore(
			restoreJob({ kind: 'volume', container: null, stop: ['tl-dep_1-0'] })
		);
		expect(result.state).toBe('succeeded');
		expect(runtime.calls).toContain('stop tl-dep_1-0 30');
		expect(runtime.containers.has('tl-dep_1-0')).toBe(false);
		expect(runtime.execs.find((e) => e.cmd[0] === 'find')!.cmd).toEqual([
			'find',
			'/data',
			'-mindepth',
			'1',
			'-delete'
		]);
		expect(runtime.archives.get('tl-helper-rst_1:/data')).toEqual(archive);
		expect(released).toEqual([['tl-dep_1-0']]);
		expect(held.size).toBe(0);
	});

	it('applies nothing from a backup that fails its integrity check', async () => {
		const { runtime, backups, serve } = setup();
		const ciphertext = await encrypted(gzipSync('-- dump'));
		ciphertext[10]! ^= 1;
		serve(ciphertext);
		expect(await backups.restore(restoreJob())).toMatchObject({
			state: 'failed',
			error: 'The backup failed its integrity check (wrong key or altered file)'
		});
		expect(runtime.archives.size).toBe(0);
		expect(runtime.execs).toEqual([]);
	});

	it('reports failures: no URL, a failed download, a stopped database, a failed load', async () => {
		const { runtime, backups, fetcher, serve } = setup();
		expect(await backups.restore(restoreJob({ url: null }))).toMatchObject({
			state: 'failed',
			error: 'No download URL for this backup'
		});
		fetcher.mockResolvedValueOnce(new Response('NoSuchKey', { status: 404 }));
		expect(await backups.restore(restoreJob())).toMatchObject({
			state: 'failed',
			error: 'Download failed: HTTP 404 NoSuchKey'
		});
		serve(await encrypted(gzipSync('-- dump')));
		expect(await backups.restore(restoreJob({ container: null }))).toMatchObject({
			state: 'failed',
			error: 'The database is not running'
		});
		runtime.onExec = (cmd, { onLine }) => {
			if (cmd[0] === 'sh') {
				onLine('stderr', 'ERROR: syntax error');
				return 3;
			}
			return 0;
		};
		expect(await backups.restore(restoreJob())).toMatchObject({
			state: 'failed',
			error: 'ERROR: syntax error'
		});
	});
});

describe('Backups.drill', () => {
	const drillJob = (overrides: Partial<DesiredDrill> = {}): DesiredDrill => ({
		id: 'drl_1',
		kind: 'volume',
		image: null,
		url: 'https://bucket.example/bak_1?X-Amz-Signature=ghi',
		key: KEY,
		...overrides
	});

	async function tarball(files: Record<string, string>) {
		const archive = pack();
		for (const [name, content] of Object.entries(files)) archive.entry({ name }, content);
		archive.finalize();
		const chunks: Buffer[] = [];
		for await (const chunk of archive) chunks.push(chunk as Buffer);
		return gzipSync(Buffer.concat(chunks));
	}

	function drillSetup(
		options: Partial<{ readyAfter: number; loadExit: number; countExit: number }> = {}
	) {
		const s = setup();
		const backups = new Backups(s.runtime, {
			stateDir: mkdtempSync(path.join(tmpdir(), 'tramline-agent-')),
			nodeId: () => 'node_1',
			hold: () => {},
			release: () => {},
			fetcher: s.fetcher,
			drillStartAttempts: 3,
			drillPollMs: 1
		});
		let checks = 0;
		s.runtime.onExec = (cmd, { onLine }) => {
			const script = cmd.at(-1)!;
			if (script.startsWith('pg_isready')) return ++checks > (options.readyAfter ?? 1) ? 0 : 2;
			if (script.includes('gunzip')) return options.loadExit ?? 0;
			if (script.startsWith('for db')) {
				if (options.countExit) {
					onLine('stderr', 'psql: error: connection refused');
					return options.countExit;
				}
				onLine('stdout', '3');
				onLine('stdout', '2');
			}
			return 0;
		};
		return { ...s, backups };
	}

	it('reads a volume archive to the end', async () => {
		const { backups, serve } = drillSetup();
		serve(await encrypted(await tarball({ 'a.txt': 'hello', 'b/c.txt': 'world!' })));
		expect(await backups.drill(drillJob())).toMatchObject({
			state: 'succeeded',
			detail: 'An archive of 2 files (11 bytes)'
		});
		serve(await encrypted(gzipSync('not a tar archive, just text that is long enough')));
		expect((await backups.drill(drillJob())).state).toBe('failed');
	});

	it('checks mysqldump and mongodump formats', async () => {
		const { backups, serve } = drillSetup();
		serve(await encrypted(gzipSync('-- MySQL dump 10.13\nCREATE TABLE t (id int);')));
		expect(await backups.drill(drillJob({ kind: 'mysql' }))).toMatchObject({
			state: 'succeeded',
			detail: expect.stringMatching(/^A complete mysqldump \(\d+ bytes\)$/)
		});
		serve(await encrypted(gzipSync('SELECT 1;')));
		expect(await backups.drill(drillJob({ kind: 'mysql' }))).toMatchObject({
			state: 'failed',
			error: 'Not a mysqldump'
		});
		serve(await encrypted(Buffer.from([0x6d, 0xe2, 0x99, 0x81, 1, 2, 3])));
		expect((await backups.drill(drillJob({ kind: 'mongo' }))).detail).toBe(
			'A complete mongodump archive'
		);
		serve(await encrypted(Buffer.from('nope')));
		expect((await backups.drill(drillJob({ kind: 'mongo' }))).error).toBe(
			'Not a mongodump archive'
		);
	});

	it('loads a Postgres dump into a scratch container with no network', async () => {
		const { runtime, backups, serve } = drillSetup({ readyAfter: 2 });
		serve(await encrypted(gzipSync('-- dump')));
		let spec: unknown;
		const run = runtime.run.bind(runtime);
		runtime.run = async (s) => {
			spec = s;
			return run(s);
		};
		const result = await backups.drill(drillJob({ kind: 'postgres', image: 'postgres:17' }));
		expect(result).toMatchObject({
			state: 'succeeded',
			detail: 'Loaded 2 databases with 5 tables into a scratch Postgres'
		});
		expect(spec).toMatchObject({
			name: 'tl-drill-drl_1',
			image: 'postgres:17',
			network: 'none',
			labels: { [LABELS.role]: 'helper' }
		});
		expect(runtime.archives.has('tl-drill-drl_1:/tmp')).toBe(true);
		// thrown away afterwards
		expect(runtime.containers.has('tl-drill-drl_1')).toBe(false);
	});

	it('fails when the scratch Postgres never starts, the load fails, or nothing is there', async () => {
		const slow = drillSetup({ readyAfter: 100 });
		slow.serve(await encrypted(gzipSync('-- dump')));
		expect(
			await slow.backups.drill(drillJob({ kind: 'postgres', image: 'postgres:17' }))
		).toMatchObject({ state: 'failed', error: 'The scratch Postgres did not start' });

		const broken = drillSetup({ loadExit: 3 });
		broken.serve(await encrypted(gzipSync('-- dump')));
		expect(
			(await broken.backups.drill(drillJob({ kind: 'postgres', image: 'postgres:17' }))).error
		).toBe('psql failed');
		expect((await broken.backups.drill(drillJob({ kind: 'postgres' }))).error).toBe(
			'No Postgres image to restore into'
		);
		expect((await broken.backups.drill(drillJob({ url: null }))).error).toBe(
			'No download URL for this backup'
		);
		// a load that "worked" but can't be checked doesn't pass
		const unchecked = drillSetup({ countExit: 2 });
		unchecked.serve(await encrypted(gzipSync('-- dump')));
		expect(
			(await unchecked.backups.drill(drillJob({ kind: 'postgres', image: 'postgres:17' }))).error
		).toBe('psql: error: connection refused');
		broken.fetcher.mockResolvedValueOnce(new Response('gone', { status: 404 }));
		expect((await broken.backups.drill(drillJob())).error).toBe('Download failed: HTTP 404 gone');
	});
});

describe('dump and load commands', () => {
	const sh = (script: string, env: Record<string, string> = {}) =>
		new Promise<{ code: number; out: Buffer; err: string }>((resolve) => {
			const child = spawn('sh', ['-c', script], { env: { ...process.env, ...env } });
			const out: Buffer[] = [];
			let err = '';
			child.stdout.on('data', (chunk) => out.push(chunk));
			child.stderr.on('data', (chunk) => (err += chunk));
			child.on('close', (code) => resolve({ code: code ?? -1, out: Buffer.concat(out), err }));
		});

	it('fail when the dump fails, even though gzip succeeds', async () => {
		const failed = await sh(guarded('echo partial; exit 42', 'gzip'));
		expect(failed.code).toBe(1);
		expect(failed.err).toContain('exit 42');

		const ok = await sh(guarded('echo all of it', 'gzip'));
		expect(ok.code).toBe(0);
		expect(gunzipSync(ok.out).toString()).toBe('all of it\n');

		// and when the consumer fails, its status is the result
		expect((await sh(guarded('echo x', 'exit 7'))).code).toBe(7);
	});

	it('stop a Postgres restore at the first error', () => {
		expect(LOAD.postgres).toContain('psql -q -v ON_ERROR_STOP=1');
	});

	it('rewrite a dump so it loads into a live server', async () => {
		const sql = [
			'DROP DATABASE IF EXISTS app;',
			'DROP ROLE IF EXISTS postgres;',
			'CREATE ROLE postgres;',
			'CREATE ROLE reporting;',
			'ALTER ROLE postgres WITH SUPERUSER;'
		].join('\n');
		// cat stands in for psql, so the rewritten SQL is what comes out
		const file = path.join(mkdtempSync(path.join(tmpdir(), 'tl-load-')), 'dump.gz');
		writeFileSync(file, gzipSync(sql));
		const { out } = await sh(LOAD.postgres.replace(/psql [^;]*-d postgres/, 'cat'), {
			FILE: file,
			POSTGRES_USER: 'postgres'
		});
		const result = out.toString();
		expect(result.split('\n').filter(Boolean)).toEqual([
			'DROP DATABASE IF EXISTS app WITH (FORCE);',
			'CREATE ROLE reporting;',
			'ALTER ROLE postgres WITH SUPERUSER;'
		]);
	});
});
