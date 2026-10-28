import type {
	Backup,
	BackupStorage,
	DesiredBackup,
	DesiredDrill,
	DesiredRestore,
	DesiredState,
	JobReport,
	SaveBackupStorage,
	UpdateVolume,
	Volume
} from '@tramline/contracts';
import { SaveBackupStorage as SaveSchema } from '@tramline/contracts';
import { and, desc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { AppError, notFound } from '../api/errors';
import { objectUrl, presign, type S3Target } from '../backups/s3';
import type { Secrets } from '../crypto';
import type { DbOrTx } from '../db/client';
import {
	backup,
	backupStorage,
	deployment,
	drill,
	project,
	restore,
	service,
	volume
} from '../db/schema';
import { publish } from '../events';
import { newId } from '../ids';
import { notifyNodes } from '../nodes/bus';
import { containerName, RUNNING_STATUSES } from '../nodes/names';
import { volumeName } from '../nodes/volumes';
import { requireInstance, requireManager } from './access';
import type { Ctx } from './context';

type VolumeRow = typeof volume.$inferSelect;
type BackupRow = typeof backup.$inferSelect;

/** Presigned URLs live this long; a backup that takes longer is retried by the schedule. */
export const URL_TTL_SECONDS = 6 * 3600;
/** Give up on a backup or restore that hasn't finished after this long. */
export const JOB_TIMEOUT_MS = 6 * 3600_000;
const INTERVAL_MS = { daily: 24 * 3600_000, weekly: 7 * 24 * 3600_000 } as const;
/** Scheduled volumes get a restore drill of their newest backup this often. */
export const DRILL_INTERVAL_MS = 7 * 24 * 3600_000;

const EXTENSION: Record<Backup['kind'], string> = {
	postgres: 'sql.gz.enc',
	mysql: 'sql.gz.enc',
	mongo: 'archive.gz.enc',
	volume: 'tar.gz.enc'
};

// ---- storage -----------------------------------------------------------------

export function getStorage(ctx: Ctx): BackupStorage | null {
	const row = ctx.db
		.select()
		.from(backupStorage)
		.where(eq(backupStorage.organizationId, ctx.organizationId))
		.get();
	if (!row) return null;
	const { endpoint, region, bucket, prefix, accessKeyId, pathStyle } = row;
	return { endpoint, region, bucket, prefix, accessKeyId, pathStyle };
}

export function saveStorage(ctx: Ctx, input: SaveBackupStorage): BackupStorage {
	requireManager(ctx, 'configure backups');
	const parsed = SaveSchema.parse(input);
	const existing = ctx.db
		.select({ secret: backupStorage.secretAccessKey })
		.from(backupStorage)
		.where(eq(backupStorage.organizationId, ctx.organizationId))
		.get();
	if (!parsed.secretAccessKey && !existing) {
		throw new AppError('validation_failed', 'Secret access key is required');
	}
	const { secretAccessKey, ...values } = parsed;
	const secret = secretAccessKey ? ctx.secrets.encrypt(secretAccessKey) : existing!.secret;
	ctx.db
		.insert(backupStorage)
		.values({ organizationId: ctx.organizationId, ...values, secretAccessKey: secret })
		.onConflictDoUpdate({
			target: backupStorage.organizationId,
			set: { ...values, secretAccessKey: secret }
		})
		.run();
	return getStorage(ctx)!;
}

export function removeStorage(ctx: Ctx) {
	requireManager(ctx, 'configure backups');
	ctx.db.delete(backupStorage).where(eq(backupStorage.organizationId, ctx.organizationId)).run();
}

/** The organization's bucket with its secret decrypted, or null when backups aren't set up. */
export function loadTarget(
	db: DbOrTx,
	secrets: Secrets,
	organizationId: string
): (S3Target & { prefix: string }) | null {
	const row = db
		.select()
		.from(backupStorage)
		.where(eq(backupStorage.organizationId, organizationId))
		.get();
	return row ? { ...row, secretAccessKey: secrets.decrypt(row.secretAccessKey) } : null;
}

/** Writes and deletes a small object, so a misconfigured bucket shows up now, not at 3am. */
export async function testStorage(ctx: Ctx, fetcher: typeof fetch = fetch) {
	requireManager(ctx, 'configure backups');
	const target = loadTarget(ctx.db, ctx.secrets, ctx.organizationId);
	if (!target) throw new AppError('conflict', 'Save the backup storage first');
	const key = [target.prefix, 'tramline', '.connection-test'].filter(Boolean).join('/');
	try {
		const put = await fetcher(presign(target, 'PUT', key, { expiresIn: 60 }), {
			method: 'PUT',
			body: 'tramline'
		});
		if (!put.ok) throw new Error(await s3Error(put, 'Writing'));
		const del = await fetcher(presign(target, 'DELETE', key, { expiresIn: 60 }), {
			method: 'DELETE'
		});
		if (!del.ok && del.status !== 404) throw new Error(await s3Error(del, 'Deleting'));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new AppError('conflict', `${objectUrl(target, key).host}: ${reason}`);
	}
	return { ok: true };
}

async function s3Error(response: Response, action: string) {
	const body = await response.text().catch(() => '');
	const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1];
	return `${action} a test object failed: HTTP ${response.status}${code ? ` ${code}` : ''}`;
}

// ---- volumes -------------------------------------------------------------------

/** Native dumps for the database templates; everything else is archived. */
export function backupKind(svc: { kind: string; icon: string | null }): Backup['kind'] {
	return svc.kind === 'database' && ['postgres', 'mysql', 'mongo'].includes(svc.icon ?? '')
		? (svc.icon as Backup['kind'])
		: 'volume';
}

function volumeDto(row: VolumeRow, svc: { kind: string; icon: string | null }): Volume {
	return {
		id: row.id,
		serviceId: row.serviceId!,
		environmentId: row.environmentId!,
		backupKind: backupKind(svc),
		backupSchedule: row.backupSchedule,
		backupRetention: row.backupRetention,
		createdAt: row.createdAt.toISOString()
	};
}

export function listVolumes(ctx: Ctx, serviceId: string, environmentId: string): Volume[] {
	const { service: svc } = requireInstance(ctx, serviceId, environmentId);
	return ctx.db
		.select()
		.from(volume)
		.where(and(eq(volume.serviceId, serviceId), eq(volume.environmentId, environmentId)))
		.all()
		.map((row) => volumeDto(row, svc));
}

function requireVolume(ctx: Ctx, id: string) {
	const row = ctx.db
		.select({ volume, service, organizationId: project.organizationId, projectId: project.id })
		.from(volume)
		.innerJoin(service, eq(volume.serviceId, service.id))
		.innerJoin(project, eq(service.projectId, project.id))
		.where(and(eq(volume.id, id), eq(project.organizationId, ctx.organizationId)))
		.get();
	if (!row || !row.volume.environmentId) throw notFound('Volume');
	return row;
}

export function updateVolume(ctx: Ctx, id: string, patch: UpdateVolume): Volume {
	const { service: svc } = requireVolume(ctx, id);
	const row = ctx.db.update(volume).set(patch).where(eq(volume.id, id)).returning().get()!;
	return volumeDto(row, svc);
}

// ---- backups -------------------------------------------------------------------

function backupDto(
	row: BackupRow,
	latest?: typeof restore.$inferSelect,
	latestDrill?: typeof drill.$inferSelect
): Backup {
	return {
		id: row.id,
		volumeId: row.volumeId,
		kind: row.kind,
		trigger: row.trigger,
		status: row.status,
		size: row.size,
		error: row.error,
		drill: latestDrill
			? {
					status: latestDrill.status,
					detail: latestDrill.detail,
					error: latestDrill.error,
					createdAt: latestDrill.createdAt.toISOString()
				}
			: null,
		restore: latest
			? {
					status: latest.status,
					error: latest.error,
					createdAt: latest.createdAt.toISOString()
				}
			: null,
		createdAt: row.createdAt.toISOString(),
		finishedAt: row.finishedAt?.toISOString() ?? null
	};
}

export function listBackups(ctx: Ctx, volumeId: string): Backup[] {
	requireVolume(ctx, volumeId);
	const rows = ctx.db
		.select()
		.from(backup)
		.where(eq(backup.volumeId, volumeId))
		.orderBy(desc(backup.createdAt), desc(backup.id))
		.all();
	const restores = rows.length
		? ctx.db
				.select()
				.from(restore)
				.where(
					inArray(
						restore.backupId,
						rows.map((r) => r.id)
					)
				)
				.orderBy(desc(restore.createdAt), desc(restore.id))
				.all()
		: [];
	const drills = rows.length
		? ctx.db
				.select()
				.from(drill)
				.where(
					inArray(
						drill.backupId,
						rows.map((r) => r.id)
					)
				)
				.orderBy(desc(drill.createdAt), desc(drill.id))
				.all()
		: [];
	return rows.map((row) =>
		backupDto(
			row,
			restores.find((r) => r.backupId === row.id),
			drills.find((d) => d.backupId === row.id)
		)
	);
}

/** Queues a restore drill of a finished backup. */
export function createDrill(db: DbOrTx, backupId: string, now = new Date()) {
	return db
		.insert(drill)
		.values({
			id: newId('drill'),
			backupId,
			status: 'pending',
			createdAt: now,
			updatedAt: now
		})
		.returning()
		.get();
}

/** Proves a backup can be restored, without touching the service. */
export function verifyBackup(ctx: Ctx, id: string): Backup {
	const { backup: row, projectId } = requireBackup(ctx, id);
	if (row.status !== 'succeeded')
		throw new AppError('conflict', 'Only finished backups can be verified');
	const running = ctx.db
		.select({ id: drill.id })
		.from(drill)
		.where(and(eq(drill.backupId, id), inArray(drill.status, ['pending', 'running'])))
		.get();
	if (running) throw new AppError('conflict', 'This backup is already being verified');
	const created = createDrill(ctx.db, id);
	notifyNodes();
	publish({ type: 'backups', projectId });
	return backupDto(row, undefined, created);
}

/** Creates a pending backup; the node holding the volume picks it up. */
export function createBackup(
	db: DbOrTx,
	secrets: Secrets,
	vol: VolumeRow,
	svc: { kind: string; icon: string | null },
	organizationId: string,
	trigger: Backup['trigger'],
	createdBy: string | null = null,
	prefix = '',
	now = new Date()
) {
	const id = newId('backup');
	const kind = backupKind(svc);
	const objectKey = [prefix, 'tramline', organizationId, vol.id, `${id}.${EXTENSION[kind]}`]
		.filter(Boolean)
		.join('/');
	return db
		.insert(backup)
		.values({
			id,
			volumeId: vol.id,
			organizationId,
			kind,
			trigger,
			status: 'pending',
			objectKey,
			wrappedKey: secrets.encrypt(randomBytes(32).toString('base64')),
			nodeId: vol.nodeId,
			createdBy,
			createdAt: now,
			updatedAt: now
		})
		.returning()
		.get();
}

export function backUp(ctx: Ctx, volumeId: string): Backup {
	const { volume: vol, service: svc, projectId } = requireVolume(ctx, volumeId);
	const target = loadTarget(ctx.db, ctx.secrets, ctx.organizationId);
	if (!target) throw new AppError('conflict', 'Set up backup storage in Settings first');
	if (!vol.nodeId) throw new AppError('conflict', 'Deploy the service before backing it up');
	if (active(ctx.db, volumeId)) {
		throw new AppError('conflict', 'A backup or restore of this volume is already running');
	}
	const row = createBackup(
		ctx.db,
		ctx.secrets,
		vol,
		svc,
		ctx.organizationId,
		'manual',
		ctx.userId,
		target.prefix
	);
	notifyNodes();
	publish({ type: 'backups', projectId });
	return backupDto(row);
}

/** Whether a backup or restore of the volume is waiting or running. */
function active(db: DbOrTx, volumeId: string) {
	const busy = ['pending', 'running'] as const;
	const backups = db
		.select({ id: backup.id, status: backup.status })
		.from(backup)
		.where(eq(backup.volumeId, volumeId))
		.all();
	if (backups.some((b) => busy.includes(b.status as (typeof busy)[number]))) return true;
	if (!backups.length) return false;
	return !!db
		.select({ id: restore.id })
		.from(restore)
		.where(
			and(
				inArray(
					restore.backupId,
					backups.map((b) => b.id)
				),
				inArray(restore.status, [...busy])
			)
		)
		.get();
}

function requireBackup(ctx: Ctx, id: string) {
	const row = ctx.db
		.select({ backup })
		.from(backup)
		.where(and(eq(backup.id, id), eq(backup.organizationId, ctx.organizationId)))
		.get();
	if (!row) throw notFound('Backup');
	return { ...requireVolume(ctx, row.backup.volumeId), backup: row.backup };
}

/** Restores a backup into its volume, replacing what is there. */
export function restoreBackup(ctx: Ctx, id: string): Backup {
	const { backup: row, projectId } = requireBackup(ctx, id);
	if (row.status !== 'succeeded')
		throw new AppError('conflict', 'Only finished backups can be restored');
	if (active(ctx.db, row.volumeId)) {
		throw new AppError('conflict', 'A backup or restore of this volume is already running');
	}
	const created = ctx.db
		.insert(restore)
		.values({ id: newId('restore'), backupId: id, status: 'pending', createdBy: ctx.userId })
		.returning()
		.get();
	notifyNodes();
	publish({ type: 'backups', projectId });
	return backupDto(row, created);
}

/** Deletes a backup and its object in the bucket. */
export async function removeBackup(ctx: Ctx, id: string, fetcher: typeof fetch = fetch) {
	const { backup: row, projectId } = requireBackup(ctx, id);
	if (row.status === 'pending' || row.status === 'running') {
		throw new AppError('conflict', 'Wait for the backup to finish');
	}
	await deleteObject(ctx.db, ctx.secrets, row, fetcher);
	ctx.db.delete(backup).where(eq(backup.id, id)).run();
	publish({ type: 'backups', projectId });
}

async function deleteObject(db: DbOrTx, secrets: Secrets, row: BackupRow, fetcher: typeof fetch) {
	if (row.status !== 'succeeded') return;
	const target = loadTarget(db, secrets, row.organizationId);
	if (!target) throw new AppError('conflict', 'Backup storage is not set up any more');
	const response = await fetcher(presign(target, 'DELETE', row.objectKey, { expiresIn: 60 }), {
		method: 'DELETE'
	});
	if (!response.ok && response.status !== 404) {
		throw new AppError('conflict', await s3Error(response, 'Deleting'));
	}
}

// ---- agent jobs ----------------------------------------------------------------

/** Running deployments per service instance (`serviceId:environmentId`), newest first. */
function liveDeployments(db: DbOrTx, volumes: VolumeRow[]) {
	const serviceIds = [...new Set(volumes.map((v) => v.serviceId).filter((id) => id !== null))];
	const live = serviceIds.length
		? db
				.select()
				.from(deployment)
				.where(
					and(
						inArray(deployment.serviceId, serviceIds),
						inArray(deployment.status, [...RUNNING_STATUSES])
					)
				)
				.orderBy(desc(deployment.createdAt), desc(deployment.id))
				.all()
		: [];
	return Map.groupBy(live, (d) => `${d.serviceId}:${d.environmentId}`);
}

/**
 * The node's pending backups and restores, without their URLs and keys: those
 * are added by `attachBackupUrls` after the revision is computed, so fresh
 * signatures don't wake every agent.
 */
export function backupJobs(db: DbOrTx, nodeId: string) {
	const backups = db
		.select({ backup, volume })
		.from(backup)
		.innerJoin(volume, eq(backup.volumeId, volume.id))
		.where(and(eq(volume.nodeId, nodeId), inArray(backup.status, ['pending', 'running'])))
		.orderBy(backup.id)
		.all();
	const restores = db
		.select({ restore, backup, volume })
		.from(restore)
		.innerJoin(backup, eq(restore.backupId, backup.id))
		.innerJoin(volume, eq(backup.volumeId, volume.id))
		.where(and(eq(volume.nodeId, nodeId), inArray(restore.status, ['pending', 'running'])))
		.orderBy(restore.id)
		.all();
	const drills = db
		.select({ drill, backup, volume })
		.from(drill)
		.innerJoin(backup, eq(drill.backupId, backup.id))
		.innerJoin(volume, eq(backup.volumeId, volume.id))
		.where(and(eq(volume.nodeId, nodeId), inArray(drill.status, ['pending', 'running'])))
		.orderBy(drill.id)
		.all();
	const deployments = liveDeployments(db, [
		...backups.map((r) => r.volume),
		...restores.map((r) => r.volume),
		...drills.map((r) => r.volume)
	]);
	const live = (vol: VolumeRow) => deployments.get(`${vol.serviceId}:${vol.environmentId}`) ?? [];
	// a native dump needs the newest running deployment; a restore stops every one using the volume
	const running = (vol: VolumeRow) => {
		const dep = live(vol).find((d) => d.status === 'active' || d.status === 'crashed');
		return dep ? containerName(dep.id, 0) : null;
	};

	const desiredBackups: DesiredBackup[] = backups.map(({ backup: b, volume: v }) => ({
		id: b.id,
		kind: b.kind,
		container: b.kind === 'volume' ? null : running(v),
		volume: volumeName(v.id),
		url: null,
		key: null
	}));
	const desiredRestores: DesiredRestore[] = restores.map(
		({ restore: r, backup: b, volume: v }) => ({
			id: r.id,
			kind: b.kind,
			container: b.kind === 'volume' ? null : running(v),
			stop:
				b.kind === 'volume'
					? live(v).flatMap((d) =>
							Array.from({ length: d.config.deploy.replicas }, (_, i) => containerName(d.id, i))
						)
					: [],
			volume: volumeName(v.id),
			url: null,
			key: null
		})
	);
	// a Postgres drill restores into the same image the service runs
	const image = (vol: VolumeRow) => {
		const dep = live(vol)[0];
		if (!dep) return null;
		return dep.image ?? (dep.config.source?.type === 'image' ? dep.config.source.image : null);
	};
	const desiredDrills: DesiredDrill[] = drills.map(({ drill: d, backup: b, volume: v }) => ({
		id: d.id,
		kind: b.kind,
		image: b.kind === 'postgres' ? image(v) : null,
		url: null,
		key: null
	}));
	return { backups: desiredBackups, restores: desiredRestores, drills: desiredDrills };
}

/** Adds each job's presigned URL and decrypted key, just before the state is sent. */
export function attachBackupUrls(
	db: DbOrTx,
	secrets: Secrets,
	desired: DesiredState,
	now = new Date()
): DesiredState {
	if (!desired.backups.length && !desired.restores.length && !desired.drills.length) {
		return desired;
	}
	const drillOf = new Map(
		db
			.select({ id: drill.id, backupId: drill.backupId })
			.from(drill)
			.where(
				inArray(
					drill.id,
					desired.drills.map((d) => d.id)
				)
			)
			.all()
			.map((d) => [d.id, d.backupId])
	);
	const backupIds = [
		...desired.backups.map((b) => b.id),
		...db
			.select({ backupId: restore.backupId })
			.from(restore)
			.where(
				inArray(
					restore.id,
					desired.restores.map((r) => r.id)
				)
			)
			.all()
			.map((r) => r.backupId),
		...drillOf.values()
	];
	const rows = new Map(
		db
			.select()
			.from(backup)
			.where(inArray(backup.id, backupIds))
			.all()
			.map((row) => [row.id, row])
	);
	const restoreOf = new Map(
		db
			.select({ id: restore.id, backupId: restore.backupId })
			.from(restore)
			.where(
				inArray(
					restore.id,
					desired.restores.map((r) => r.id)
				)
			)
			.all()
			.map((r) => [r.id, r.backupId])
	);
	const targets = new Map<string, ReturnType<typeof loadTarget>>();
	const target = (organizationId: string) => {
		if (!targets.has(organizationId))
			targets.set(organizationId, loadTarget(db, secrets, organizationId));
		return targets.get(organizationId)!;
	};
	const sign = (row: BackupRow | undefined, method: 'PUT' | 'GET') => {
		const bucket = row && target(row.organizationId);
		if (!row || !bucket) return { url: null, key: null };
		return {
			url: presign(bucket, method, row.objectKey, { expiresIn: URL_TTL_SECONDS, now }),
			key: secrets.decrypt(row.wrappedKey)
		};
	};
	return {
		...desired,
		backups: desired.backups.map((job) => ({ ...job, ...sign(rows.get(job.id), 'PUT') })),
		restores: desired.restores.map((job) => ({
			...job,
			...sign(rows.get(restoreOf.get(job.id) ?? ''), 'GET')
		})),
		drills: desired.drills.map((job) => ({
			...job,
			...sign(rows.get(drillOf.get(job.id) ?? ''), 'GET')
		}))
	};
}

/** A job report as sent, before defaults. */
type Reported = Pick<JobReport, 'id' | 'state'> &
	Partial<Pick<JobReport, 'size' | 'error' | 'detail'>>;

/** Applies what an agent reported about its backups, restores and drills. */
export function recordJobReports(
	db: DbOrTx,
	nodeId: string,
	reports: { backups: Reported[]; restores: Reported[]; drills?: Reported[] }
) {
	const finished = (r: Reported) => (r.state === 'running' ? null : new Date());
	let changed = false;
	// only jobs on this node's volumes
	const mine = db.select({ id: backup.id }).from(backup).where(eq(backup.nodeId, nodeId));
	for (const r of reports.backups) {
		const row = db
			.update(backup)
			.set({
				status: r.state,
				size: r.size ?? null,
				error: r.error ?? null,
				finishedAt: finished(r)
			})
			.where(
				and(
					eq(backup.id, r.id),
					eq(backup.nodeId, nodeId),
					inArray(backup.status, ['pending', 'running'])
				)
			)
			.returning({ id: backup.id })
			.get();
		if (row) changed = true;
	}
	for (const r of reports.restores) {
		const row = db
			.update(restore)
			.set({ status: r.state, error: r.error ?? null, finishedAt: finished(r) })
			.where(
				and(
					eq(restore.id, r.id),
					inArray(restore.backupId, mine),
					inArray(restore.status, ['pending', 'running'])
				)
			)
			.returning({ id: restore.id })
			.get();
		if (row) changed = true;
	}
	for (const r of reports.drills ?? []) {
		const row = db
			.update(drill)
			.set({
				status: r.state,
				detail: r.detail ?? null,
				error: r.error ?? null,
				finishedAt: finished(r)
			})
			.where(
				and(
					eq(drill.id, r.id),
					inArray(drill.backupId, mine),
					inArray(drill.status, ['pending', 'running'])
				)
			)
			.returning({ id: drill.id })
			.get();
		if (row) changed = true;
	}
	if (changed) announceAll(db);
}

/** Tells every project with backups to refresh; cheap, and backup events are rare. */
function announceAll(db: DbOrTx) {
	const rows = db
		.select({ projectId: service.projectId })
		.from(volume)
		.innerJoin(service, eq(volume.serviceId, service.id))
		.innerJoin(backup, eq(backup.volumeId, volume.id))
		.groupBy(service.projectId)
		.all();
	for (const { projectId } of rows) publish({ type: 'backups', projectId });
}

// ---- schedules -----------------------------------------------------------------

/**
 * Runs once a minute: starts scheduled backups that are due, fails jobs that
 * ran too long, drills each scheduled volume's newest backup weekly, and
 * deletes scheduled backups beyond each volume's retention.
 */
export async function runBackupSchedules(
	db: DbOrTx,
	secrets: Secrets,
	{ now = Date.now(), fetcher = fetch, log = console.warn } = {}
) {
	let created = 0;
	let drilled = 0;
	const scheduled = db
		.select({ volume, service, organizationId: project.organizationId })
		.from(volume)
		.innerJoin(service, eq(volume.serviceId, service.id))
		.innerJoin(project, eq(service.projectId, project.id))
		.where(
			and(
				inArray(volume.backupSchedule, ['daily', 'weekly']),
				isNotNull(volume.environmentId),
				isNotNull(volume.nodeId)
			)
		)
		.all();

	for (const { volume: vol, service: svc, organizationId } of scheduled) {
		const target = loadTarget(db, secrets, organizationId);
		if (!target || active(db, vol.id)) continue;
		const last = db
			.select({ createdAt: backup.createdAt })
			.from(backup)
			.where(and(eq(backup.volumeId, vol.id), eq(backup.trigger, 'scheduled')))
			.orderBy(desc(backup.createdAt))
			.get();
		const interval = INTERVAL_MS[vol.backupSchedule as keyof typeof INTERVAL_MS];
		if (last && now - last.createdAt.getTime() < interval) continue;
		createBackup(
			db,
			secrets,
			vol,
			svc,
			organizationId,
			'scheduled',
			null,
			target.prefix,
			new Date(now)
		);
		created++;
	}

	// jobs that never finished, e.g. the node went away
	const cutoff = new Date(now - JOB_TIMEOUT_MS);
	const timedOut = { status: 'failed' as const, error: 'Timed out', finishedAt: new Date(now) };
	db.update(backup)
		.set(timedOut)
		.where(and(inArray(backup.status, ['pending', 'running']), lt(backup.createdAt, cutoff)))
		.run();
	db.update(restore)
		.set(timedOut)
		.where(and(inArray(restore.status, ['pending', 'running']), lt(restore.createdAt, cutoff)))
		.run();
	db.update(drill)
		.set(timedOut)
		.where(and(inArray(drill.status, ['pending', 'running']), lt(drill.createdAt, cutoff)))
		.run();

	// a weekly restore drill of each scheduled volume's newest backup
	for (const { volume: vol } of scheduled) {
		const latest = db
			.select()
			.from(backup)
			.where(and(eq(backup.volumeId, vol.id), eq(backup.status, 'succeeded')))
			.orderBy(desc(backup.createdAt), desc(backup.id))
			.get();
		if (!latest) continue;
		const lastDrill = db
			.select({ createdAt: drill.createdAt })
			.from(drill)
			.innerJoin(backup, eq(drill.backupId, backup.id))
			.where(eq(backup.volumeId, vol.id))
			.orderBy(desc(drill.createdAt))
			.get();
		if (lastDrill && now - lastDrill.createdAt.getTime() < DRILL_INTERVAL_MS) continue;
		createDrill(db, latest.id, new Date(now));
		drilled++;
	}

	// retention: the newest N successful scheduled backups stay. Failures are trimmed on their
	// own, so a run of failed backups never pushes out the last good recovery points
	for (const { volume: vol } of scheduled) {
		const finished = (status: 'succeeded' | 'failed') =>
			db
				.select()
				.from(backup)
				.where(
					and(
						eq(backup.volumeId, vol.id),
						eq(backup.trigger, 'scheduled'),
						eq(backup.status, status)
					)
				)
				.orderBy(desc(backup.createdAt), desc(backup.id))
				.all()
				.slice(vol.backupRetention);
		const old = [...finished('succeeded'), ...finished('failed')];
		for (const row of old) {
			try {
				await deleteObject(db, secrets, row, fetcher);
				db.delete(backup).where(eq(backup.id, row.id)).run();
			} catch (error) {
				log(`[backups] could not delete ${row.objectKey}: ${(error as Error).message}`);
			}
		}
	}

	if (created || drilled) {
		notifyNodes();
		announceAll(db);
	}
	/** Scheduled backups started. */
	return created;
}
