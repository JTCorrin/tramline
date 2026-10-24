import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { controlPlaneBackup, organization } from '../db/schema';
import { createTestDb } from '../testing';
import {
	controlPlaneBucket,
	drillControlPlane,
	listSnapshots,
	restoreControlPlane,
	snapshotControlPlane,
	snapshotKey,
	snapshotName,
	type ControlPlaneBucket
} from './control-plane';
import { controlPlaneBackupStatus, runControlPlaneBackups } from './control-plane-jobs';
import { MAGIC } from './format';
import { listObjects } from './s3';

const BUCKET: ControlPlaneBucket = {
	endpoint: 'https://s3.example.com',
	region: 'us-east-1',
	bucket: 'install',
	prefix: 'ops',
	accessKeyId: 'AKID',
	secretAccessKey: 'secret',
	pathStyle: true
};
const KEY = snapshotKey('a-test-secret-key-that-is-long-enough');

/** An in-memory bucket that serves presigned requests, including ListObjectsV2. */
function fakeS3({ pageSize = 1000 } = {}) {
	const objects = new Map<string, Buffer>();
	const fetcher = vi.fn<typeof fetch>(async (input, init) => {
		const url = new URL(String(input));
		expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
		const key = decodeURIComponent(url.pathname.replace(/^\/install\/?/, ''));
		const method = init?.method ?? 'GET';
		if (method === 'PUT') {
			const chunks: Buffer[] = [];
			for await (const chunk of init!.body as unknown as AsyncIterable<Uint8Array>)
				chunks.push(Buffer.from(chunk));
			objects.set(key, Buffer.concat(chunks));
			return new Response(null, { status: 200 });
		}
		if (method === 'DELETE') {
			objects.delete(key);
			return new Response(null, { status: 204 });
		}
		if (url.searchParams.get('list-type') === '2') {
			const prefix = url.searchParams.get('prefix') ?? '';
			const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
			const start = Number(url.searchParams.get('continuation-token') ?? 0);
			const page = all.slice(start, start + pageSize);
			const more = start + pageSize < all.length;
			return new Response(
				`<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : ''}</ListBucketResult>`
			);
		}
		const object = objects.get(key);
		return object
			? new Response(new Uint8Array(object))
			: new Response('NoSuchKey', { status: 404 });
	});
	return { objects, fetcher };
}

const at = (hours: number) => new Date(Date.UTC(2026, 9, 24, hours));

describe('control-plane backup settings', () => {
	it('is off until the endpoint, bucket and keys are set', () => {
		expect(controlPlaneBucket({})).toBeNull();
		expect(
			controlPlaneBucket({
				TRAMLINE_BACKUP_S3_ENDPOINT: 'https://s3.example.com/',
				TRAMLINE_BACKUP_S3_BUCKET: 'install',
				TRAMLINE_BACKUP_S3_ACCESS_KEY_ID: 'AKID',
				TRAMLINE_BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
				TRAMLINE_BACKUP_S3_PREFIX: '/ops/',
				TRAMLINE_BACKUP_S3_PATH_STYLE: 'false'
			})
		).toEqual({ ...BUCKET, pathStyle: false });
		// a different secret key gives a different snapshot key
		expect(snapshotKey('another-secret-key-that-is-long-enough')).not.toEqual(KEY);
		expect(snapshotName(BUCKET, at(9))).toBe(
			'ops/tramline/control-plane/2026-10-24T09-00-00-000Z.sqlite.gz.enc'
		);
	});
});

describe('control-plane snapshots', () => {
	it('uploads an encrypted copy of the live database and keeps the newest N', async () => {
		const db = createTestDb();
		db.insert(organization)
			.values({ id: 'org_1', name: 'Acme', slug: 'acme', createdAt: new Date() })
			.run();
		const { objects, fetcher } = fakeS3();
		for (let hour = 0; hour < 4; hour++) {
			await snapshotControlPlane(db.$client, {
				bucket: BUCKET,
				key: KEY,
				keep: 2,
				now: at(hour),
				fetcher
			});
		}
		expect([...objects.keys()].sort()).toEqual([
			snapshotName(BUCKET, at(2)),
			snapshotName(BUCKET, at(3))
		]);
		const stored = objects.get(snapshotName(BUCKET, at(3)))!;
		expect(stored.subarray(0, 4)).toEqual(MAGIC);
		expect(stored.includes(Buffer.from('Acme'))).toBe(false);

		// a drill opens it and finds the data
		const drill = await drillControlPlane(BUCKET, KEY, fetcher);
		expect(drill).toMatchObject({ snapshot: snapshotName(BUCKET, at(3)), organizations: 1 });
		expect(drill.tables).toBeGreaterThan(10);
	});

	it('refuses a snapshot that was altered or is read with the wrong key', async () => {
		const db = createTestDb();
		const { objects, fetcher } = fakeS3();
		await snapshotControlPlane(db.$client, {
			bucket: BUCKET,
			key: KEY,
			keep: 5,
			now: at(1),
			fetcher
		});
		await expect(
			drillControlPlane(BUCKET, snapshotKey('the-wrong-secret-key-but-long-enough'), fetcher)
		).rejects.toThrow('failed its integrity check');
		const name = snapshotName(BUCKET, at(1));
		const altered = Buffer.from(objects.get(name)!);
		altered[40]! ^= 1;
		objects.set(name, altered);
		await expect(drillControlPlane(BUCKET, KEY, fetcher)).rejects.toThrow(
			'failed its integrity check'
		);
		await expect(drillControlPlane({ ...BUCKET, prefix: 'empty' }, KEY, fetcher)).rejects.toThrow(
			'There are no control-plane snapshots'
		);
	});

	it('restores over the database file, keeping the old one and its WAL aside', async () => {
		const db = createTestDb();
		db.insert(organization)
			.values({ id: 'org_1', name: 'Acme', slug: 'acme', createdAt: new Date() })
			.run();
		const { fetcher } = fakeS3();
		await snapshotControlPlane(db.$client, {
			bucket: BUCKET,
			key: KEY,
			keep: 5,
			now: at(1),
			fetcher
		});

		const dir = mkdtempSync(path.join(tmpdir(), 'tramline-restore-'));
		const file = path.join(dir, 'tramline.db');
		writeFileSync(file, 'the broken database');
		writeFileSync(`${file}-wal`, 'stale wal');
		const { snapshot, kept } = await restoreControlPlane(BUCKET, KEY, file, {
			now: at(5),
			fetcher
		});
		expect(snapshot).toBe(snapshotName(BUCKET, at(1)));
		expect(readFileSync(kept, 'utf8')).toBe('the broken database');
		expect(readFileSync(`${kept}-wal`, 'utf8')).toBe('stale wal');
		expect(existsSync(`${file}-wal`)).toBe(false);
		const restored = new Database(file, { readonly: true });
		expect(restored.prepare('select name from organization').get()).toEqual({ name: 'Acme' });
		restored.close();
	});

	it('fails cleanly when the upload is refused', async () => {
		const db = createTestDb();
		const fetcher = vi.fn<typeof fetch>(async () => new Response('denied', { status: 403 }));
		await expect(
			snapshotControlPlane(db.$client, { bucket: BUCKET, key: KEY, keep: 5, fetcher })
		).rejects.toThrow('Upload failed: HTTP 403');
	});
});

describe('listObjects', () => {
	it('follows continuation tokens and unescapes keys', async () => {
		const { objects, fetcher } = fakeS3({ pageSize: 2 });
		for (const k of ['a/3', 'a/1', 'a/2&b', 'b/1']) objects.set(k, Buffer.from('x'));
		expect(await listObjects(BUCKET, 'a/', fetcher)).toEqual(['a/1', 'a/2&b', 'a/3']);
		expect(await listSnapshots(BUCKET, fetcher)).toEqual([]);
		const failing = vi.fn<typeof fetch>(
			async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })
		);
		await expect(listObjects(BUCKET, '', failing)).rejects.toThrow(
			'Listing the bucket failed: HTTP 403 AccessDenied'
		);
	});
});

describe('runControlPlaneBackups', () => {
	it('snapshots on the interval, drills daily, and records failures', async () => {
		const db = createTestDb();
		const { fetcher } = fakeS3();
		const config = { bucket: BUCKET, key: KEY, intervalMinutes: 60, keep: 10 };
		const run = (hours: number, f = fetcher) =>
			runControlPlaneBackups(db, config, { now: at(hours), fetcher: f });

		// off without a bucket, or with a zero interval
		await runControlPlaneBackups(db, { ...config, bucket: null }, { fetcher });
		await runControlPlaneBackups(db, { ...config, intervalMinutes: 0 }, { fetcher });
		expect(controlPlaneBackupStatus(db, false)).toEqual({
			configured: false,
			snapshot: null,
			drill: null
		});

		await run(0);
		const first = controlPlaneBackupStatus(db, true);
		expect(first.snapshot).toMatchObject({ status: 'succeeded' });
		expect(first.drill).toMatchObject({ status: 'succeeded', detail: { organizations: 0 } });

		await run(0.5);
		await run(1);
		const rows = db.select().from(controlPlaneBackup).all();
		expect(rows.filter((r) => r.kind === 'snapshot')).toHaveLength(2);
		// one drill a day
		expect(rows.filter((r) => r.kind === 'drill')).toHaveLength(1);

		const broken = vi.fn<typeof fetch>(async () => new Response('down', { status: 503 }));
		await run(2, broken);
		expect(controlPlaneBackupStatus(db, true).snapshot).toMatchObject({
			status: 'failed',
			error: 'Upload failed: HTTP 503'
		});

		await run(25);
		expect(controlPlaneBackupStatus(db, true).drill?.createdAt).toBe(at(25).toISOString());
	});

	it('keeps a bounded history', async () => {
		const db = createTestDb();
		for (let i = 0; i < 105; i++) {
			db.insert(controlPlaneBackup)
				.values({ kind: 'snapshot', status: 'failed', error: 'x', createdAt: at(0) })
				.run();
		}
		const { fetcher } = fakeS3();
		await runControlPlaneBackups(
			db,
			{ bucket: BUCKET, key: KEY, intervalMinutes: 60, keep: 10 },
			{ now: at(1), fetcher }
		);
		expect(db.select().from(controlPlaneBackup).all()).toHaveLength(100);
	});
});
