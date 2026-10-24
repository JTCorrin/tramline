import type { AgentHello } from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { backup, backupStorage, drill, member, restore } from '../db/schema';
import { buildDesiredState, containerName } from '../nodes/desired';
import { reconcile } from '../nodes/reconciler';
import { ensureLocalNode, recordHello, recordReport } from '../nodes/registry';
import { volumeName } from '../nodes/volumes';
import { seedCtx, testSecrets } from '../testing';
import * as backups from './backups';
import * as changes from './changes';
import * as environments from './environments';
import * as projects from './projects';
import * as services from './services';

const hello: AgentHello = {
	protocol: 1,
	agentVersion: 'test',
	hostname: 'box',
	os: 'linux',
	arch: 'arm64',
	cpus: 4,
	memoryMb: 8192,
	docker: { version: '27.0.0' }
};

const STORAGE = {
	endpoint: 'https://s3.example.com',
	region: 'eu-west-1',
	bucket: 'acme-backups',
	prefix: 'prod',
	accessKeyId: 'AKIDEXAMPLE',
	secretAccessKey: 'shh-secret',
	pathStyle: true
};

/** A deployed Postgres (or plain volume service) with its volume on the local node. */
function setup(kind: 'database' | 'image' = 'database') {
	const ctx = seedCtx();
	ctx.settings = { ...ctx.settings, dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-bk-')) };
	const { node } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
	recordHello(ctx.db, node.id, hello);
	const project = projects.create(ctx, { name: 'Shop' });
	const [env] = environments.list(ctx, project.id);
	const svc =
		kind === 'database'
			? services.create(ctx, { projectId: project.id, kind: 'database', engine: 'postgres' })
			: services.create(ctx, {
					projectId: project.id,
					kind: 'image',
					source: { type: 'image', image: 'redis:7' }
				});
	if (kind === 'image')
		services.stageConfig(ctx, svc.id, env!.id, { volume: { mountPath: '/data' } });
	services.stageConfig(ctx, svc.id, env!.id, { build: { scan: 'off' } });
	const [dep] = changes.deploy(ctx, env!.id);
	reconcile(ctx.db, ctx.settings);
	recordReport(ctx.db, node.id, {
		revision: null,
		containers: [
			{
				name: containerName(dep!.id, 0),
				deploymentId: dep!.id,
				replica: 0,
				state: 'running',
				healthy: null,
				exitCode: null,
				restartCount: 0,
				error: null,
				startedAt: new Date(Date.now() - 10_000).toISOString()
			}
		]
	});
	reconcile(ctx.db, ctx.settings);
	const [vol] = backups.listVolumes(ctx, svc.id, env!.id);
	return { ctx, node, env: env!, svc, dep: dep!, vol: vol! };
}

const desired = (s: ReturnType<typeof setup>) =>
	buildDesiredState(s.ctx.db, testSecrets, s.ctx.settings, s.node.id);

describe('backup storage', () => {
	it('saves the bucket with its secret encrypted and never returns it', () => {
		const { ctx } = setup();
		expect(backups.getStorage(ctx)).toBeNull();
		expect(() => backups.saveStorage(ctx, { ...STORAGE, secretAccessKey: undefined })).toThrow(
			'Secret access key is required'
		);
		const saved = backups.saveStorage(ctx, { ...STORAGE, endpoint: 'https://s3.example.com/' });
		expect(saved).toEqual({
			endpoint: 'https://s3.example.com',
			region: 'eu-west-1',
			bucket: 'acme-backups',
			prefix: 'prod',
			accessKeyId: 'AKIDEXAMPLE',
			pathStyle: true
		});
		const row = ctx.db.select().from(backupStorage).get()!;
		expect(row.secretAccessKey).not.toContain('shh-secret');
		expect(backups.loadTarget(ctx.db, testSecrets, ctx.organizationId)?.secretAccessKey).toBe(
			'shh-secret'
		);

		// updating without a secret keeps the saved one
		backups.saveStorage(ctx, { ...STORAGE, bucket: 'other', secretAccessKey: undefined });
		expect(backups.loadTarget(ctx.db, testSecrets, ctx.organizationId)).toMatchObject({
			bucket: 'other',
			secretAccessKey: 'shh-secret'
		});
		backups.removeStorage(ctx);
		expect(backups.getStorage(ctx)).toBeNull();
	});

	it('is managed by owners and admins only', () => {
		const { ctx } = setup();
		ctx.db.update(member).set({ role: 'member' }).where(eq(member.userId, ctx.userId)).run();
		expect(() => backups.saveStorage(ctx, STORAGE)).toThrow(
			'Only organization owners and admins can configure backups'
		);
	});

	it('tests the bucket by writing and deleting an object with presigned URLs', async () => {
		const { ctx } = setup();
		await expect(backups.testStorage(ctx)).rejects.toThrow('Save the backup storage first');
		backups.saveStorage(ctx, STORAGE);
		const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		expect(await backups.testStorage(ctx, fetcher)).toEqual({ ok: true });
		const [put, del] = fetcher.mock.calls.map(([url, init]) => [String(url), init?.method]);
		expect(put![0]).toMatch(
			/^https:\/\/s3\.example\.com\/acme-backups\/prod\/tramline\/\.connection-test\?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F\d{8}%2Feu-west-1%2Fs3%2Faws4_request/
		);
		expect(put![0]).not.toContain('shh-secret');
		expect([put![1], del![1]]).toEqual(['PUT', 'DELETE']);

		fetcher.mockResolvedValueOnce(
			new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })
		);
		await expect(backups.testStorage(ctx, fetcher)).rejects.toThrow(
			's3.example.com: Writing a test object failed: HTTP 403 AccessDenied'
		);
	});
});

describe('backups', () => {
	it('knows what a backup of each service contains', () => {
		expect(backups.backupKind({ kind: 'database', icon: 'postgres' })).toBe('postgres');
		expect(backups.backupKind({ kind: 'database', icon: 'mongo' })).toBe('mongo');
		// Redis's append-only files are archived with the volume
		expect(backups.backupKind({ kind: 'database', icon: 'redis' })).toBe('volume');
		expect(backups.backupKind({ kind: 'image', icon: null })).toBe('volume');
		expect(setup().vol).toMatchObject({
			backupKind: 'postgres',
			backupSchedule: 'off',
			backupRetention: 7
		});
	});

	it('needs storage, and one job at a time', () => {
		const { ctx, vol } = setup();
		expect(() => backups.backUp(ctx, vol.id)).toThrow('Set up backup storage in Settings first');
		backups.saveStorage(ctx, STORAGE);
		backups.backUp(ctx, vol.id);
		expect(() => backups.backUp(ctx, vol.id)).toThrow('already running');
	});

	it('sends a native dump job to the node, with a presigned upload and its key', () => {
		const s = setup();
		backups.saveStorage(s.ctx, STORAGE);
		const created = backups.backUp(s.ctx, s.vol.id);
		expect(created).toMatchObject({ kind: 'postgres', trigger: 'manual', status: 'pending' });

		const state = desired(s);
		expect(state.backups).toEqual([
			{
				id: created.id,
				kind: 'postgres',
				container: containerName(s.dep.id, 0),
				volume: volumeName(s.vol.id),
				url: null,
				key: null
			}
		]);
		const withUrls = backups.attachBackupUrls(s.ctx.db, testSecrets, state);
		const job = withUrls.backups[0]!;
		const row = s.ctx.db.select().from(backup).where(eq(backup.id, created.id)).get()!;
		expect(row.objectKey).toBe(
			`prod/tramline/${s.ctx.organizationId}/${s.vol.id}/${created.id}.sql.gz.enc`
		);
		expect(job.url).toContain(`/acme-backups/${row.objectKey}?X-Amz-Algorithm=`);
		expect(job.url).toContain('X-Amz-Expires=21600');
		expect(Buffer.from(job.key!, 'base64')).toHaveLength(32);
		// the key is stored wrapped, not as is
		expect(row.wrappedKey).not.toContain(job.key!);
		// urls are added after the revision, so re-signing doesn't wake agents
		expect(withUrls.revision).toBe(state.revision);
	});

	it('records progress from the node, and stops sending finished jobs', () => {
		const s = setup();
		backups.saveStorage(s.ctx, STORAGE);
		const created = backups.backUp(s.ctx, s.vol.id);
		const report = (state: 'running' | 'succeeded', size: number | null = null) =>
			recordReport(s.ctx.db, s.node.id, {
				revision: null,
				containers: [],
				backups: [{ id: created.id, state, size, error: null }]
			});
		report('running');
		expect(backups.listBackups(s.ctx, s.vol.id)[0]!.status).toBe('running');
		report('succeeded', 1234);
		expect(backups.listBackups(s.ctx, s.vol.id)[0]).toMatchObject({
			status: 'succeeded',
			size: 1234
		});
		expect(desired(s).backups).toEqual([]);
		// a late report can't move it back
		report('running');
		expect(backups.listBackups(s.ctx, s.vol.id)[0]!.status).toBe('succeeded');
	});

	it('restores a finished backup, stopping the containers of a volume service', () => {
		const s = setup('image');
		backups.saveStorage(s.ctx, STORAGE);
		const created = backups.backUp(s.ctx, s.vol.id);
		expect(() => backups.restoreBackup(s.ctx, created.id)).toThrow(
			'Only finished backups can be restored'
		);
		recordReport(s.ctx.db, s.node.id, {
			revision: null,
			containers: [],
			backups: [{ id: created.id, state: 'succeeded', size: 10, error: null }]
		});

		const restored = backups.restoreBackup(s.ctx, created.id);
		expect(restored.restore).toMatchObject({ status: 'pending' });
		expect(() => backups.restoreBackup(s.ctx, created.id)).toThrow('already running');

		const state = desired(s);
		expect(state.restores).toEqual([
			{
				id: expect.stringMatching(/^rst_/),
				kind: 'volume',
				container: null,
				stop: [containerName(s.dep.id, 0)],
				volume: volumeName(s.vol.id),
				url: null,
				key: null
			}
		]);
		const job = backups.attachBackupUrls(s.ctx.db, testSecrets, state).restores[0]!;
		// downloads are signed for GET, with the same key the backup was encrypted with
		expect(job.url).toContain('.tar.gz.enc?X-Amz-Algorithm=');
		const row = s.ctx.db.select().from(backup).where(eq(backup.id, created.id)).get()!;
		expect(job.key).toBe(testSecrets.decrypt(row.wrappedKey));

		recordReport(s.ctx.db, s.node.id, {
			revision: null,
			containers: [],
			restores: [{ id: state.restores[0]!.id, state: 'failed', size: null, error: 'boom' }]
		});
		expect(backups.listBackups(s.ctx, s.vol.id)[0]!.restore).toMatchObject({
			status: 'failed',
			error: 'boom'
		});
	});

	it('verifies a backup with a restore drill into the same Postgres image', () => {
		const s = setup();
		backups.saveStorage(s.ctx, STORAGE);
		const created = backups.backUp(s.ctx, s.vol.id);
		expect(() => backups.verifyBackup(s.ctx, created.id)).toThrow(
			'Only finished backups can be verified'
		);
		recordReport(s.ctx.db, s.node.id, {
			revision: null,
			containers: [],
			backups: [{ id: created.id, state: 'succeeded', size: 10, error: null }]
		});

		expect(backups.verifyBackup(s.ctx, created.id).drill).toMatchObject({ status: 'pending' });
		expect(() => backups.verifyBackup(s.ctx, created.id)).toThrow('already being verified');

		const state = desired(s);
		expect(state.drills).toEqual([
			{
				id: expect.stringMatching(/^drl_/),
				kind: 'postgres',
				image: 'postgres:17',
				url: null,
				key: null
			}
		]);
		const job = backups.attachBackupUrls(s.ctx.db, testSecrets, state).drills[0]!;
		expect(job.url).toContain('.sql.gz.enc?X-Amz-Algorithm=');
		expect(job.key).toBeTruthy();

		recordReport(s.ctx.db, s.node.id, {
			revision: null,
			containers: [],
			drills: [
				{
					id: job.id,
					state: 'succeeded',
					size: null,
					error: null,
					detail: 'Loaded 1 database with 3 tables into a scratch Postgres'
				}
			]
		});
		expect(backups.listBackups(s.ctx, s.vol.id)[0]!.drill).toMatchObject({
			status: 'succeeded',
			detail: 'Loaded 1 database with 3 tables into a scratch Postgres'
		});
		expect(desired(s).drills).toEqual([]);
	});

	it('deletes a backup and its object', async () => {
		const s = setup();
		backups.saveStorage(s.ctx, STORAGE);
		const created = backups.backUp(s.ctx, s.vol.id);
		await expect(backups.removeBackup(s.ctx, created.id)).rejects.toThrow('Wait for the backup');
		recordReport(s.ctx.db, s.node.id, {
			revision: null,
			containers: [],
			backups: [{ id: created.id, state: 'succeeded', size: 10, error: null }]
		});
		const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
		await backups.removeBackup(s.ctx, created.id, fetcher);
		expect(fetcher.mock.calls[0]![1]?.method).toBe('DELETE');
		expect(backups.listBackups(s.ctx, s.vol.id)).toEqual([]);
	});

	it('keeps other organizations out', () => {
		const s = setup();
		const other = seedCtx(s.ctx.db);
		expect(() => backups.listBackups(other, s.vol.id)).toThrow('Volume not found');
		expect(() => backups.updateVolume(other, s.vol.id, { backupSchedule: 'daily' })).toThrow(
			'Volume not found'
		);
	});
});

describe('backup schedules', () => {
	it('backs up when due, keeps the newest N, and times out stuck jobs', async () => {
		const s = setup();
		const now = Date.now();
		const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
		const run = (at: number) =>
			backups.runBackupSchedules(s.ctx.db, testSecrets, { now: at, fetcher, log: () => {} });

		// nothing without a schedule or storage
		expect(await run(now)).toBe(0);
		backups.updateVolume(s.ctx, s.vol.id, { backupSchedule: 'daily', backupRetention: 2 });
		expect(await run(now)).toBe(0);
		backups.saveStorage(s.ctx, STORAGE);

		const finish = () => {
			for (const job of desired(s).backups) {
				recordReport(s.ctx.db, s.node.id, {
					revision: null,
					containers: [],
					backups: [{ id: job.id, state: 'succeeded', size: 1, error: null }]
				});
			}
		};
		for (let day = 0; day < 4; day++) {
			const at = now + day * 24 * 3600_000 + 1000;
			expect(await run(at)).toBe(1);
			// not due again the same day
			expect(await run(at + 3600_000)).toBe(0);
			finish();
		}
		await run(now + 4 * 24 * 3600_000);
		// the newest two scheduled backups are kept; the rest are deleted from the bucket
		const left = backups.listBackups(s.ctx, s.vol.id).filter((b) => b.status === 'succeeded');
		expect(left).toHaveLength(2);
		expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(2);

		// the newest backup was drilled once this week, not every day
		const drills = s.ctx.db.select().from(drill).all();
		expect(drills).toHaveLength(1);
		const drilled = backups.listBackups(s.ctx, s.vol.id).find((b) => b.drill);
		// no agent picks it up here, so like any job it times out
		expect(drilled?.drill?.status).toBe('failed');

		// a job that never finishes is failed eventually
		const manual = backups.backUp(s.ctx, s.vol.id);
		await run(now + 30 * 24 * 3600_000);
		expect(s.ctx.db.select().from(backup).where(eq(backup.id, manual.id)).get()!).toMatchObject({
			status: 'failed',
			error: 'Timed out'
		});
		expect(s.ctx.db.select().from(restore).all()).toEqual([]);
	});
});
