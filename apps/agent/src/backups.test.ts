import type { DesiredBackup, DesiredRestore } from '@tramline/contracts';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { extract } from 'tar-stream';
import { describe, expect, it, vi } from 'vitest';
import { Backups, decryptFile, DUMP, encrypt, LOAD, MAGIC } from './backups';
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
			error: null
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
