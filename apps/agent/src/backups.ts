import type { DesiredBackup, DesiredRestore, JobReport } from '@tramline/contracts';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { pack } from 'tar-stream';
import { HELPER_IMAGE } from './pins';
import { LABELS, type ContainerRuntime } from './runtime';

/** Encrypted backup format: magic, 12-byte IV, AES-256-GCM ciphertext, 16-byte tag. */
export const MAGIC = Buffer.from('TLB1');

/**
 * Native dumps run inside the database's own container, with the credentials
 * already in its environment, so no password ever appears on a command line
 * outside it. Each writes a gzip stream to stdout.
 */
export const DUMP: Record<'postgres' | 'mysql' | 'mongo', string> = {
	postgres: 'pg_dumpall --clean --if-exists -U "$POSTGRES_USER" | gzip',
	mysql:
		'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot --all-databases --single-transaction --routines --events --triggers | gzip',
	mongo:
		'mongodump --archive --gzip --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'
};

/** Loads a dump copied to `$FILE` inside the database's container. */
export const LOAD: Record<'postgres' | 'mysql' | 'mongo', string> = {
	// connected apps would block DROP DATABASE (and the dump would load on top of the old data)
	postgres:
		'gunzip -c "$FILE" | sed -E \'s/^DROP DATABASE IF EXISTS (.*);$/DROP DATABASE IF EXISTS \\1 WITH (FORCE);/\' | psql -q -U "$POSTGRES_USER" -d postgres',
	mysql: 'gunzip -c "$FILE" | MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot',
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
	const size = statSync(input).size;
	if (size < MAGIC.length + 12 + 16) throw new Error('The backup is truncated');
	const handle = await open(input, 'r');
	try {
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
				? createReadStream(input, { start: head.length, end: size - 17 })
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
