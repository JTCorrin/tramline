import { desc, eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { controlPlaneBackup } from '../db/schema';
import { drillControlPlane, snapshotControlPlane, type ControlPlaneBucket } from './control-plane';

/** A drill runs this often against the newest snapshot. */
export const DRILL_INTERVAL_MS = 24 * 3600_000;
/** Status rows kept. */
const HISTORY = 100;

export interface ControlPlaneBackupConfig {
	bucket: ControlPlaneBucket | null;
	key: Buffer;
	intervalMinutes: number;
	keep: number;
}

type Row = typeof controlPlaneBackup.$inferSelect;

function last(db: Db, kind: Row['kind']) {
	return db
		.select()
		.from(controlPlaneBackup)
		.where(eq(controlPlaneBackup.kind, kind))
		.orderBy(desc(controlPlaneBackup.createdAt), desc(controlPlaneBackup.id))
		.get();
}

/**
 * Runs once a minute: snapshots the database when one is due, and runs a
 * restore drill against the newest snapshot once a day. Results are recorded
 * for Settings. Failures are retried on the next interval, never sooner.
 */
export async function runControlPlaneBackups(
	db: Db,
	config: ControlPlaneBackupConfig,
	{ now = new Date(), fetcher = fetch }: { now?: Date; fetcher?: typeof fetch } = {}
) {
	const { bucket, key, intervalMinutes, keep } = config;
	if (!bucket || !intervalMinutes) return;
	const record = (values: Omit<typeof controlPlaneBackup.$inferInsert, 'createdAt'>) =>
		db
			.insert(controlPlaneBackup)
			.values({ ...values, createdAt: now })
			.run();
	const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

	const snapshot = last(db, 'snapshot');
	if (!snapshot || now.getTime() - snapshot.createdAt.getTime() >= intervalMinutes * 60_000) {
		try {
			const { name, size } = await snapshotControlPlane(db.$client, {
				bucket,
				key,
				keep,
				now,
				fetcher
			});
			record({ kind: 'snapshot', status: 'succeeded', objectKey: name, size });
		} catch (error) {
			record({ kind: 'snapshot', status: 'failed', error: message(error) });
		}
	}

	const drill = last(db, 'drill');
	const hasSnapshot = last(db, 'snapshot')?.status === 'succeeded';
	if (hasSnapshot && (!drill || now.getTime() - drill.createdAt.getTime() >= DRILL_INTERVAL_MS)) {
		try {
			const result = await drillControlPlane(bucket, key, fetcher);
			const { snapshot: name, ...detail } = result;
			record({ kind: 'drill', status: 'succeeded', objectKey: name, detail });
		} catch (error) {
			record({ kind: 'drill', status: 'failed', error: message(error) });
		}
	}

	// keep a bounded history
	const cutoff = db
		.select({ id: controlPlaneBackup.id })
		.from(controlPlaneBackup)
		.orderBy(desc(controlPlaneBackup.id))
		.limit(1)
		.offset(HISTORY)
		.get();
	if (cutoff)
		db.delete(controlPlaneBackup)
			.where(lt(controlPlaneBackup.id, cutoff.id + 1))
			.run();
}

/** The latest snapshot and drill, for Settings. */
export function controlPlaneBackupStatus(db: Db, configured: boolean) {
	const view = (row: Row | undefined) =>
		row && {
			status: row.status,
			size: row.size,
			detail: row.detail,
			error: row.error,
			createdAt: row.createdAt.toISOString()
		};
	return {
		configured,
		snapshot: view(last(db, 'snapshot')) ?? null,
		drill: view(last(db, 'drill')) ?? null
	};
}
