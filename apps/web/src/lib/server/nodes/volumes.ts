import { and, eq, isNull, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { deployment, volume } from '../db/schema';
import { newId } from '../ids';

export type VolumeRow = typeof volume.$inferSelect;

/** The Docker volume's name on the node. */
export const volumeName = (id: string) => `tl-${id}`;

export function volumeFor(db: DbOrTx, serviceId: string, environmentId: string) {
	return db
		.select()
		.from(volume)
		.where(and(eq(volume.serviceId, serviceId), eq(volume.environmentId, environmentId)))
		.get();
}

/** The service's volume in an environment, created on first use and pinned to `nodeId`. */
export function ensureVolume(
	db: DbOrTx,
	serviceId: string,
	environmentId: string,
	nodeId: string
): VolumeRow {
	const existing = volumeFor(db, serviceId, environmentId);
	if (existing?.nodeId) return existing;
	if (existing) {
		return db.update(volume).set({ nodeId }).where(eq(volume.id, existing.id)).returning().get()!;
	}
	return db
		.insert(volume)
		.values({ id: newId('volume'), serviceId, environmentId, nodeId })
		.returning()
		.get();
}

/** Volumes whose service or environment was deleted. */
const orphaned = or(isNull(volume.serviceId), isNull(volume.environmentId));

/** Docker volumes the node should remove: those of deleted services and environments. */
export function deletedVolumes(db: DbOrTx, nodeId: string) {
	return db
		.select({ id: volume.id })
		.from(volume)
		.where(and(eq(volume.nodeId, nodeId), orphaned))
		.all()
		.map((row) => volumeName(row.id))
		.sort();
}

/**
 * Forgets deleted volumes once the node no longer reports them (and those
 * that never reached a node).
 */
export function recordVolumes(db: DbOrTx, nodeId: string, present: string[]) {
	const reported = new Set(present);
	const gone = db
		.select({ id: volume.id, nodeId: volume.nodeId })
		.from(volume)
		.where(and(or(eq(volume.nodeId, nodeId), isNull(volume.nodeId)), orphaned))
		.all()
		.filter((row) => !row.nodeId || !reported.has(volumeName(row.id)));
	for (const row of gone) db.delete(volume).where(eq(volume.id, row.id)).run();
}

type DeploymentRow = typeof deployment.$inferSelect;

const LIVE: DeploymentRow['status'][] = ['deploying', 'active', 'crashed'];

/**
 * Services with a volume are recreated rather than swapped: two containers
 * must never share one data directory. Of their live deployments only the
 * newest may run, and only once the older ones' containers are gone. GPU
 * services are too when the newest was given GPUs an older one still holds
 * (a node with one GPU, say); with GPUs to spare they swap like any other.
 *
 * `withContainers` holds the deployments whose containers a node still reports.
 */
export function recreatePlan(deployments: DeploymentRow[], withContainers: Set<string>) {
	const stopped = new Map<string, string>();
	const waiting = new Set<string>();
	const live = deployments.filter((d) => LIVE.includes(d.status));
	const plan = (
		group: DeploymentRow[],
		mustStop: (older: DeploymentRow, newest: DeploymentRow) => boolean
	) => {
		const ordered = group.toSorted(
			(a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
		);
		const newest = ordered.at(-1)!;
		const older = ordered.slice(0, -1).filter((dep) => mustStop(dep, newest));
		for (const dep of older) stopped.set(dep.id, newest.id);
		if (older.some((dep) => withContainers.has(dep.id))) waiting.add(newest.id);
	};
	const byService = (d: DeploymentRow) => `${d.serviceId}:${d.environmentId}`;
	for (const group of Map.groupBy(
		live.filter((d) => d.config.volume?.mountPath),
		byService
	).values()) {
		plan(group, () => true);
	}
	for (const group of Map.groupBy(
		live.filter((d) => d.replicaGpus?.length),
		byService
	).values()) {
		plan(group, (older, newest) => gpusOf(older).some((gpu) => gpusOf(newest).includes(gpu)));
	}
	/** `stopped`: older deployment → the one replacing it. `waiting`: may not start yet. */
	return { stopped, waiting };
}

/** `node/gpu` for every GPU a deployment's replicas hold. */
function gpusOf(dep: DeploymentRow) {
	return (dep.replicaGpus ?? []).flatMap((gpus, replica) =>
		gpus.map((gpu) => `${dep.replicaNodes?.[replica] ?? dep.nodeId}/${gpu}`)
	);
}
