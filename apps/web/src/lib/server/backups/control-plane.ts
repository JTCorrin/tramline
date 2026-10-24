import Database from 'better-sqlite3';
import { hkdfSync } from 'node:crypto';
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { decryptFile, encrypt } from './format';
import { listObjects, presign, type S3Target } from './s3';

/** The install-wide bucket for the control plane's own database. */
export interface ControlPlaneBucket extends S3Target {
	prefix: string;
}

/** Reads `TRAMLINE_BACKUP_S3_*`; null when control-plane backups are off. */
export function controlPlaneBucket(
	env: Record<string, string | undefined>
): ControlPlaneBucket | null {
	const endpoint = env.TRAMLINE_BACKUP_S3_ENDPOINT;
	const bucket = env.TRAMLINE_BACKUP_S3_BUCKET;
	const accessKeyId = env.TRAMLINE_BACKUP_S3_ACCESS_KEY_ID;
	const secretAccessKey = env.TRAMLINE_BACKUP_S3_SECRET_ACCESS_KEY;
	if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
	return {
		endpoint: endpoint.replace(/\/+$/, ''),
		bucket,
		accessKeyId,
		secretAccessKey,
		region: env.TRAMLINE_BACKUP_S3_REGION || 'us-east-1',
		prefix: (env.TRAMLINE_BACKUP_S3_PREFIX ?? '').replace(/^\/+|\/+$/g, ''),
		pathStyle: env.TRAMLINE_BACKUP_S3_PATH_STYLE !== 'false'
	};
}

/**
 * Snapshots are encrypted with a key derived from TRAMLINE_SECRET_KEY: the
 * database is useless without that key anyway (its secrets are encrypted with
 * it), and a derived key means nothing extra to keep safe.
 */
export const snapshotKey = (secretKey: string) =>
	Buffer.from(hkdfSync('sha256', secretKey, 'tramline', 'control-plane-backup-v1', 32));

const folder = (bucket: ControlPlaneBucket) =>
	[bucket.prefix, 'tramline', 'control-plane'].filter(Boolean).join('/');

/** e.g. `tramline/control-plane/2026-10-24T09-00-00-000Z.sqlite.gz.enc`; names sort by time. */
export const snapshotName = (bucket: ControlPlaneBucket, at: Date) =>
	`${folder(bucket)}/${at.toISOString().replace(/[:.]/g, '-')}.sqlite.gz.enc`;

export interface SnapshotOptions {
	bucket: ControlPlaneBucket;
	key: Buffer;
	/** Snapshots kept; older ones are deleted. */
	keep: number;
	now?: Date;
	fetcher?: typeof fetch;
}

/**
 * Takes a consistent copy of the live database (`VACUUM INTO`, safe while it
 * is in use), compresses and encrypts it, uploads it, and deletes snapshots
 * beyond `keep`. Returns the uploaded object's key and size.
 */
export async function snapshotControlPlane(sqlite: Database.Database, options: SnapshotOptions) {
	const { bucket, key, keep, now = new Date(), fetcher = fetch } = options;
	const dir = mkdtempSync(path.join(tmpdir(), 'tramline-snapshot-'));
	try {
		const copy = path.join(dir, 'tramline.db');
		sqlite.prepare('VACUUM INTO ?').run(copy);
		const encrypted = path.join(dir, 'snapshot.enc');
		await pipeline(
			createReadStream(copy),
			createGzip(),
			encrypt(key),
			createWriteStream(encrypted)
		);

		const name = snapshotName(bucket, now);
		const size = statSync(encrypted).size;
		const response = await fetcher(presign(bucket, 'PUT', name, { expiresIn: 3600 }), {
			method: 'PUT',
			headers: { 'content-length': String(size) },
			body: Readable.toWeb(createReadStream(encrypted)) as ReadableStream,
			duplex: 'half'
		} as RequestInit);
		if (!response.ok) throw new Error(`Upload failed: HTTP ${response.status}`);

		const snapshots = await listSnapshots(bucket, fetcher);
		for (const old of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
			const del = await fetcher(presign(bucket, 'DELETE', old, { expiresIn: 60 }), {
				method: 'DELETE'
			});
			if (!del.ok && del.status !== 404)
				throw new Error(`Deleting ${old} failed: HTTP ${del.status}`);
		}
		return { name, size };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Snapshot keys, oldest first. */
export async function listSnapshots(bucket: ControlPlaneBucket, fetcher: typeof fetch = fetch) {
	return (await listObjects(bucket, `${folder(bucket)}/`, fetcher)).filter((k) =>
		k.endsWith('.sqlite.gz.enc')
	);
}

/**
 * Downloads a snapshot (the newest by default), checks it authenticates and
 * decompresses, and writes the database to `output`. Returns its key.
 */
export async function fetchSnapshot(
	bucket: ControlPlaneBucket,
	key: Buffer,
	output: string,
	{ name, fetcher = fetch }: { name?: string; fetcher?: typeof fetch } = {}
) {
	const target = name ?? (await listSnapshots(bucket, fetcher)).at(-1);
	if (!target) throw new Error('There are no control-plane snapshots in the bucket');
	const dir = mkdtempSync(path.join(tmpdir(), 'tramline-restore-'));
	try {
		const response = await fetcher(presign(bucket, 'GET', target, { expiresIn: 600 }));
		if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
		const encrypted = path.join(dir, 'snapshot.enc');
		await pipeline(
			Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
			createWriteStream(encrypted)
		);
		const compressed = path.join(dir, 'snapshot.gz');
		await decryptFile(encrypted, compressed, key);
		await pipeline(
			createReadStream(compressed),
			createGunzip(),
			createWriteStream(output, { mode: 0o600 })
		);
		return target;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** What a restore drill found in a snapshot. */
export interface DrillResult {
	snapshot: string;
	tables: number;
	organizations: number;
	projects: number;
	deployments: number;
}

/**
 * A restore drill: fetches the newest snapshot into a scratch file, then
 * opens it and runs SQLite's integrity check, as a real restore would need.
 */
export async function drillControlPlane(
	bucket: ControlPlaneBucket,
	key: Buffer,
	fetcher: typeof fetch = fetch
): Promise<DrillResult> {
	const dir = mkdtempSync(path.join(tmpdir(), 'tramline-drill-'));
	try {
		const file = path.join(dir, 'tramline.db');
		const snapshot = await fetchSnapshot(bucket, key, file, { fetcher });
		const db = new Database(file, { readonly: true });
		try {
			const check = db.pragma('integrity_check', { simple: true });
			if (check !== 'ok') throw new Error(`The snapshot failed SQLite's integrity check: ${check}`);
			const count = (table: string) =>
				(db.prepare(`select count(*) as n from "${table}"`).get() as { n: number }).n;
			return {
				snapshot,
				tables: count('sqlite_master'),
				organizations: count('organization'),
				projects: count('project'),
				deployments: count('deployment')
			};
		} finally {
			db.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Replaces the database file with a snapshot. Only while Tramline is stopped:
 * the current file is kept next to it, and the WAL files are moved aside so
 * SQLite doesn't replay them onto the restored database.
 */
export async function restoreControlPlane(
	bucket: ControlPlaneBucket,
	key: Buffer,
	databasePath: string,
	{
		name,
		now = new Date(),
		fetcher = fetch
	}: { name?: string; now?: Date; fetcher?: typeof fetch } = {}
) {
	const staging = `${databasePath}.restoring`;
	const snapshot = await fetchSnapshot(bucket, key, staging, { name, fetcher });
	const check = new Database(staging, { readonly: true });
	try {
		const result = check.pragma('integrity_check', { simple: true });
		if (result !== 'ok') throw new Error(`The snapshot failed SQLite's integrity check: ${result}`);
	} finally {
		check.close();
	}
	const kept = `${databasePath}.before-restore-${now.toISOString().replace(/[:.]/g, '-')}`;
	for (const suffix of ['', '-wal', '-shm']) {
		if (existsSync(databasePath + suffix)) renameSync(databasePath + suffix, kept + suffix);
	}
	renameSync(staging, databasePath);
	return { snapshot, kept };
}
