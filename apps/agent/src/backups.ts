import type { DesiredBackup, DesiredDrill, DesiredRestore, JobReport } from '@tramline/contracts';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { extract, pack } from 'tar-stream';
import { HELPER_IMAGE } from './pins';
import { LABELS, type ContainerRuntime } from './runtime';
import { WORKLOAD_CAPABILITIES } from './spec';

/** Encrypted backup format: magic, 12-byte IV, AES-256-GCM ciphertext, 16-byte tag. */
export const MAGIC = Buffer.from('TLB1');

/**
 * `producer | consumer` in POSIX sh, failing when either fails. These images'
 * `sh` has no `pipefail`, so a failed dump piped into gzip would otherwise
 * exit 0 with a valid, empty archive. The producer's failure is noted in a
 * file named after this shell's PID, which only the shell and its pipeline see.
 */
export const guarded = (producer: string, consumer: string) =>
	`S=/tmp/tramline-pipe.$$; rm -f "$S"; { (${producer}) || echo $? > "$S"; } | ${consumer}; C=$?; ` +
	// a consumer that stops early (psql at an error) leaves the producer a broken pipe: its own
	// failure is the one to report
	`if [ $C -ne 0 ]; then rm -f "$S"; exit $C; fi; ` +
	`if [ -s "$S" ]; then echo "the dump or decompression failed (exit $(cat "$S"))" >&2; rm -f "$S"; exit 1; fi; exit 0`;

/**
 * Native dumps run inside the database's own container, with the credentials
 * already in its environment, so no password ever appears on a command line
 * outside it. Each writes a gzip stream to stdout, and fails if the dump does.
 */
export const DUMP: Record<'postgres' | 'mysql' | 'mongo', string> = {
	postgres: guarded('pg_dumpall --clean --if-exists -U "$POSTGRES_USER"', 'gzip'),
	mysql: guarded(
		'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot --all-databases --single-transaction --routines --events --triggers',
		'gzip'
	),
	mongo:
		'mongodump --archive --gzip --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'
};

/**
 * Turns `pg_dumpall --clean` output into something that loads cleanly into a
 * live server: dropping a database other sessions use needs FORCE, and the
 * superuser the server runs as can be neither dropped nor created again.
 */
const POSTGRES_PREPARE =
	`sed -E -e 's/^DROP DATABASE IF EXISTS (.*);$/DROP DATABASE IF EXISTS \\1 WITH (FORCE);/' ` +
	`-e '/^(DROP ROLE IF EXISTS|CREATE ROLE) "?'"$POSTGRES_USER"'"?;$/d'`;

/**
 * Loads a dump copied to `$FILE` inside the database's container. Every load
 * stops at the first error, so a partial restore is reported as failed.
 */
export const LOAD: Record<'postgres' | 'mysql' | 'mongo', string> = {
	postgres: guarded(
		'gunzip -c "$FILE"',
		`${POSTGRES_PREPARE} | psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres`
	),
	// mysql stops at the first error in batch mode
	mysql: guarded('gunzip -c "$FILE"', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot'),
	mongo:
		'mongorestore --archive="$FILE" --gzip --drop --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'
};

const RESTORE_DIR = '/tmp';

export interface BackupOptions {
	stateDir: string;
	nodeId: () => string;
	/** Holds containers so convergence doesn't restart them during a volume restore. */
	hold: (names: string[]) => void;
	release: (names: string[]) => void;
	fetcher?: typeof fetch;
	log?: (message: string) => void;
	/** How long a drill waits for its scratch Postgres (tests shorten it). */
	drillStartAttempts?: number;
	drillPollMs?: number;
}

/**
 * Takes and restores backups. Everything that leaves the node is gzip-compressed
 * and then encrypted with the per-backup key the control plane sends; uploads
 * and downloads go through presigned URLs, so the node never holds bucket
 * credentials.
 */
export class Backups {
	constructor(
		private runtime: ContainerRuntime,
		private options: BackupOptions
	) {}

	get #dir() {
		const dir = path.join(this.options.stateDir, 'backups');
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return dir;
	}

	async backup(job: DesiredBackup): Promise<JobReport> {
		const report = (state: JobReport['state'], extra: Partial<JobReport> = {}): JobReport => ({
			id: job.id,
			state,
			size: null,
			error: null,
			detail: null,
			...extra
		});
		if (!job.url || !job.key) return report('failed', { error: 'No upload URL for this backup' });
		const file = path.join(this.#dir, `${job.id}.enc`);
		const helper = `tl-helper-${job.id}`;
		try {
			const errors: string[] = [];
			const onLine = (stream: string, line: string) => {
				if (stream === 'stderr') errors.push(line);
			};
			const raw = new PassThrough();
			let produced: Promise<number>;
			if (job.kind === 'volume') {
				await this.#helper(helper, job.volume, true);
				// an archive of the volume, compressed here
				produced = this.runtime.execStream(helper, ['tar', '-c', '-C', '/data', '.'], {
					onLine,
					stdout: raw
				});
				const written = pipeline(raw, createGzip(), encrypt(job.key), createWriteStream(file));
				const code = await produced;
				await written;
				if (code !== 0) throw new Error(lastLines(errors) || `tar exited with ${code}`);
			} else {
				if (!job.container) throw new Error('The database is not running');
				produced = this.runtime.execStream(job.container, ['sh', '-c', DUMP[job.kind]], {
					onLine,
					stdout: raw
				});
				const written = pipeline(raw, encrypt(job.key), createWriteStream(file));
				const code = await produced;
				await written;
				if (code !== 0) throw new Error(lastLines(errors) || `the dump exited with ${code}`);
			}

			const size = statSync(file).size;
			const response = await (this.options.fetcher ?? fetch)(job.url, {
				method: 'PUT',
				headers: { 'content-length': String(size), 'content-type': 'application/octet-stream' },
				body: Readable.toWeb(createReadStream(file)) as ReadableStream,
				duplex: 'half'
			} as RequestInit);
			if (!response.ok) {
				throw new Error(`Upload failed: HTTP ${response.status} ${await bodyText(response)}`);
			}
			return report('succeeded', { size });
		} catch (error) {
			return report('failed', { error: message(error) });
		} finally {
			rmSync(file, { force: true });
			await this.runtime.remove(helper).catch(ignore);
		}
	}

	async restore(job: DesiredRestore): Promise<JobReport> {
		const report = (state: JobReport['state'], extra: Partial<JobReport> = {}): JobReport => ({
			id: job.id,
			state,
			size: null,
			error: null,
			detail: null,
			...extra
		});
		if (!job.url || !job.key) return report('failed', { error: 'No download URL for this backup' });
		const encrypted = path.join(this.#dir, `${job.id}.enc`);
		const plain = path.join(this.#dir, `${job.id}.gz`);
		const helper = `tl-helper-${job.id}`;
		const held = job.kind === 'volume' ? job.stop : [];
		try {
			const response = await (this.options.fetcher ?? fetch)(job.url);
			if (!response.ok || !response.body) {
				throw new Error(`Download failed: HTTP ${response.status} ${await bodyText(response)}`);
			}
			await pipeline(
				Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
				createWriteStream(encrypted)
			);
			// nothing is applied unless the whole backup decrypts and authenticates
			await decryptFile(encrypted, plain, job.key);

			if (job.kind === 'volume') {
				this.options.hold(held);
				for (const name of held) {
					await this.runtime.stop(name, 30);
					await this.runtime.remove(name);
				}
				await this.#helper(helper, job.volume, false);
				const wipe = await this.runtime.execStream(
					helper,
					['find', '/data', '-mindepth', '1', '-delete'],
					{ onLine: ignore }
				);
				if (wipe !== 0) throw new Error('Could not clear the volume');
				await this.runtime.putArchive(helper, '/data', createReadStream(plain));
			} else {
				if (!job.container) throw new Error('The database is not running');
				const file = `${RESTORE_DIR}/tramline-restore-${job.id}.gz`;
				await this.runtime.putArchive(
					job.container,
					RESTORE_DIR,
					tarOf(path.basename(file), plain)
				);
				const errors: string[] = [];
				const code = await this.runtime.execStream(job.container, ['sh', '-c', LOAD[job.kind]], {
					env: { FILE: file },
					onLine: (stream, line) => {
						if (stream === 'stderr') errors.push(line);
					}
				});
				await this.runtime
					.execStream(job.container, ['rm', '-f', file], { onLine: ignore })
					.catch(ignore);
				if (code !== 0) throw new Error(lastLines(errors) || `the restore exited with ${code}`);
			}
			return report('succeeded');
		} catch (error) {
			return report('failed', { error: message(error) });
		} finally {
			rmSync(encrypted, { force: true });
			rmSync(plain, { force: true });
			await this.runtime.remove(helper).catch(ignore);
			// the agent's next pass starts the stopped containers again
			this.options.release(held);
		}
	}

	/**
	 * Proves a backup can be restored without touching the service: it must
	 * decrypt and authenticate, decompress, and parse. A Postgres dump is
	 * loaded into a throwaway Postgres with no network.
	 */
	async drill(job: DesiredDrill): Promise<JobReport> {
		const report = (state: JobReport['state'], extra: Partial<JobReport> = {}): JobReport => ({
			id: job.id,
			state,
			size: null,
			error: null,
			detail: null,
			...extra
		});
		if (!job.url || !job.key) return report('failed', { error: 'No download URL for this backup' });
		const encrypted = path.join(this.#dir, `${job.id}.enc`);
		const plain = path.join(this.#dir, `${job.id}.out`);
		const scratch = `tl-drill-${job.id}`;
		try {
			const response = await (this.options.fetcher ?? fetch)(job.url);
			if (!response.ok || !response.body) {
				throw new Error(`Download failed: HTTP ${response.status} ${await bodyText(response)}`);
			}
			await pipeline(
				Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
				createWriteStream(encrypted)
			);
			await decryptFile(encrypted, plain, job.key);

			if (job.kind === 'volume') {
				const { files, bytes } = await readArchive(plain);
				return report('succeeded', {
					detail: `An archive of ${files} ${files === 1 ? 'file' : 'files'} (${bytes} bytes)`
				});
			}
			if (job.kind === 'mongo') {
				const head = await firstBytes(plain, 4);
				// mongodump archives start with the magic number 0x8199e26d, little-endian
				if (!head.equals(Buffer.from([0x6d, 0xe2, 0x99, 0x81]))) {
					throw new Error('Not a mongodump archive');
				}
				return report('succeeded', { detail: 'A complete mongodump archive' });
			}
			const sql = await gunzipCheck(plain);
			if (job.kind === 'mysql') {
				if (!/^-- (MySQL|MariaDB) dump/.test(sql.head)) throw new Error('Not a mysqldump');
				return report('succeeded', { detail: `A complete mysqldump (${sql.bytes} bytes)` });
			}
			if (!job.image) throw new Error('No Postgres image to restore into');
			return report('succeeded', { detail: await this.#loadPostgres(scratch, job, plain) });
		} catch (error) {
			return report('failed', { error: message(error) });
		} finally {
			rmSync(encrypted, { force: true });
			rmSync(plain, { force: true });
			await this.runtime.remove(scratch).catch(ignore);
		}
	}

	/** Loads a dump into a scratch Postgres and counts what arrived. */
	async #loadPostgres(name: string, job: DesiredDrill, dump: string) {
		const image = job.image!;
		if (!(await this.runtime.hasImage(image))) await this.runtime.pull(image);
		await this.runtime.run({
			name,
			image,
			env: {
				POSTGRES_PASSWORD: randomBytes(16).toString('hex'),
				POSTGRES_HOST_AUTH_METHOD: 'trust'
			},
			network: 'none',
			aliases: [],
			restart: { name: 'no', maxRetries: 0 },
			security: {
				capabilities: WORKLOAD_CAPABILITIES,
				pidsLimit: 1024,
				memoryMb: 1024,
				readOnlyRootFilesystem: false
			},
			labels: {
				[LABELS.managed]: 'true',
				[LABELS.node]: this.options.nodeId(),
				[LABELS.role]: 'helper'
			}
		});
		const run = async (command: string) => {
			let out = '';
			const errors: string[] = [];
			const code = await this.runtime.execStream(name, ['sh', '-c', command], {
				onLine: (stream, line) => (stream === 'stdout' ? (out += `${line}\n`) : errors.push(line))
			});
			return { code, out: out.trim(), errors };
		};
		// the image's init runs a socket-only server first; TCP answers once the real one is up
		for (let attempt = 0; ; attempt++) {
			if ((await run('pg_isready -q -h 127.0.0.1 -U postgres')).code === 0) break;
			if (attempt >= (this.options.drillStartAttempts ?? 120)) {
				throw new Error('The scratch Postgres did not start');
			}
			await sleep(this.options.drillPollMs ?? 500);
		}
		const file = `/tmp/tramline-drill-${job.id}.gz`;
		await this.runtime.putArchive(name, '/tmp', tarOf(path.basename(file), dump));
		// the same rewrite as a real restore: the scratch server's own superuser stays put
		const load = await run(
			'POSTGRES_USER=postgres; ' +
				guarded(
					`gunzip -c ${file}`,
					`${POSTGRES_PREPARE} | psql -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres`
				)
		);
		if (load.code !== 0) throw new Error(lastLines(load.errors) || 'psql failed');
		const counted = await run(
			`for db in $(psql -h 127.0.0.1 -U postgres -tAc "select datname from pg_database where not datistemplate and datname <> 'postgres'"); do psql -h 127.0.0.1 -U postgres -d "$db" -tAc "select count(*) from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')"; done`
		);
		if (counted.code !== 0) {
			throw new Error(lastLines(counted.errors) || 'Counting the restored tables failed');
		}
		const counts = counted.out.split('\n').filter(Boolean).map(Number);
		if (!counts.length || counts.some(Number.isNaN)) {
			throw new Error('The restored dump has no databases to check');
		}
		const tables = counts.reduce((a, b) => a + b, 0);
		return `Loaded ${counts.length} ${counts.length === 1 ? 'database' : 'databases'} with ${tables} ${tables === 1 ? 'table' : 'tables'} into a scratch Postgres`;
	}

	/**
	 * A short-lived container with the volume at /data: no network, and only the
	 * capabilities needed to read (or, for restores, write) files owned by other users.
	 */
	async #helper(name: string, volume: string, readOnly: boolean) {
		if (!(await this.runtime.hasImage(HELPER_IMAGE))) await this.runtime.pull(HELPER_IMAGE);
		await this.runtime.run({
			name,
			image: HELPER_IMAGE,
			cmd: ['sleep', '3600'],
			env: {},
			network: 'none',
			aliases: [],
			restart: { name: 'no', maxRetries: 0 },
			volumes: [{ name: volume, target: '/data', readOnly }],
			security: {
				capabilities: readOnly
					? ['DAC_READ_SEARCH']
					: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID'],
				pidsLimit: 64,
				memoryMb: 256,
				readOnlyRootFilesystem: true
			},
			labels: {
				[LABELS.managed]: 'true',
				[LABELS.node]: this.options.nodeId(),
				[LABELS.role]: 'helper'
			}
		});
	}
}

/** Streams plaintext into the encrypted backup format. */
export function encrypt(keyBase64: string) {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
	let started = false;
	return new Transform({
		transform(chunk: Buffer, _encoding, done) {
			const head = started ? [] : [MAGIC, iv];
			started = true;
			done(null, Buffer.concat([...head, cipher.update(chunk)]));
		},
		flush(done) {
			const head = started ? [] : [MAGIC, iv];
			done(null, Buffer.concat([...head, cipher.final(), cipher.getAuthTag()]));
		}
	});
}

/** Decrypts a backup file, failing (and leaving no output) if it was altered or the key is wrong. */
export async function decryptFile(input: string, output: string, keyBase64: string) {
	// one open file throughout, so what is checked is what is decrypted
	const handle = await open(input, 'r');
	try {
		const { size } = await handle.stat();
		if (size < MAGIC.length + 12 + 16) throw new Error('The backup is truncated');
		const head = Buffer.alloc(MAGIC.length + 12);
		await handle.read(head, 0, head.length, 0);
		if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Tramline backup');
		const tag = Buffer.alloc(16);
		await handle.read(tag, 0, 16, size - 16);
		const decipher = createDecipheriv(
			'aes-256-gcm',
			Buffer.from(keyBase64, 'base64'),
			head.subarray(MAGIC.length)
		);
		decipher.setAuthTag(tag);
		const ciphertext =
			size > head.length + 16
				? handle.createReadStream({ start: head.length, end: size - 17, autoClose: false })
				: Readable.from([]);
		await pipeline(ciphertext, decipher, createWriteStream(output, { mode: 0o600 }));
	} catch (error) {
		rmSync(output, { force: true });
		throw message(error).includes('authenticate')
			? new Error('The backup failed its integrity check (wrong key or altered file)')
			: error;
	} finally {
		await handle.close();
	}
}

/** A one-file tar archive, streamed from disk as it is read. */
/** Reads a gzipped tar archive to the end, counting files and bytes. */
export async function readArchive(file: string) {
	let files = 0;
	let bytes = 0;
	const tar = extract();
	tar.on('entry', (header, stream, next) => {
		if (header.type === 'file') files++;
		stream.on('data', (chunk: unknown) => (bytes += (chunk as Buffer).length));
		stream.on('end', next);
		stream.resume();
	});
	await pipeline(createReadStream(file), createGunzip(), tar);
	return { files, bytes };
}

/** Decompresses a gzip file to the end, returning its first line and size. */
export async function gunzipCheck(file: string) {
	let head = '';
	let bytes = 0;
	await pipeline(createReadStream(file), createGunzip(), async function (source) {
		for await (const chunk of source) {
			if (head.length < 200) head += (chunk as Buffer).toString('utf8', 0, 200);
			bytes += (chunk as Buffer).length;
		}
	});
	return { head, bytes };
}

async function firstBytes(file: string, length: number) {
	const handle = await open(file, 'r');
	try {
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

export function tarOf(name: string, file: string) {
	const archive = pack();
	const entry = archive.entry({ name, size: statSync(file).size, mode: 0o600 }, (error) =>
		error ? archive.destroy(error) : archive.finalize()
	);
	createReadStream(file)
		.on('error', (error) => archive.destroy(error))
		.pipe(entry);
	return archive as unknown as NodeJS.ReadableStream;
}

const ignore = () => {};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const lastLines = (lines: string[]) => lines.slice(-3).join(' ').slice(0, 500);
const bodyText = async (response: Response) =>
	(await response.text().catch(() => '')).slice(0, 200);
