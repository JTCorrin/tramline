import { ulid } from 'ulid';
import { eq } from 'drizzle-orm';
import type { Secrets } from '../crypto';
import type { DbOrTx } from '../db/client';
import { node } from '../db/schema';
import type { PlatformSettings } from '../settings';
import { notifyNodes } from './bus';
import { buildDesiredState } from './desired';
import { agentUpdateState, nodeStatus } from './registry';

/**
 * How long after an automatic update a node must still be online before the
 * next node is updated: an image that starts, then breaks, stops the rollout.
 */
export const ROLLOUT_WATCH_MS = 60 * 60_000;

type NodeRow = typeof node.$inferSelect;

/** Work an agent restart would cut short: builds, scans, backups, restores, drills, queries. */
function busy(db: DbOrTx, secrets: Secrets, settings: PlatformSettings, row: NodeRow) {
	const desired = buildDesiredState(db, secrets, settings, row.id);
	return (
		desired.builds.length +
			desired.scans.length +
			desired.backups.length +
			desired.restores.length +
			desired.drills.length +
			desired.queries.length >
		0
	);
}

/**
 * Keeps agents on the latest image without anyone asking. Every
 * `agentUpdateHours`, each node that can update itself is asked to (the
 * same request as the Nodes page's Update agent button): the agent pulls its
 * image again and restarts only if it changed.
 *
 * One node at a time: none starts while another is updating, or while a node
 * updated automatically in the last hour is offline, since a bad image would
 * otherwise reach every node. A node with a build or backup running waits
 * for it. Returns the node asked, if any.
 */
export function autoUpdateAgents(
	db: DbOrTx,
	secrets: Secrets,
	settings: PlatformSettings,
	now = Date.now()
): string | null {
	const hours = settings.agentUpdateHours ?? 0;
	if (hours <= 0) return null;
	const interval = hours * 3600_000;
	const rows = db.select().from(node).all();

	for (const row of rows) {
		const update = agentUpdateState(row.agentUpdate, now);
		if (update && !update.finishedAt) return null;
		if (
			update?.requestedBy === null &&
			now - Date.parse(update.finishedAt!) < ROLLOUT_WATCH_MS &&
			nodeStatus(row, now) === 'offline'
		) {
			return null;
		}
	}

	// the node waiting longest goes first: its last update, or when it joined
	const since = (row: NodeRow) =>
		row.agentUpdate ? Date.parse(row.agentUpdate.requestedAt) : row.createdAt.getTime();
	const due = rows
		.filter(
			(row) =>
				row.info?.features?.includes('self-update') &&
				nodeStatus(row, now) === 'online' &&
				now - since(row) >= interval
		)
		.sort((a, b) => since(a) - since(b));

	for (const row of due) {
		if (busy(db, secrets, settings, row)) continue;
		db.update(node)
			.set({
				agentUpdate: {
					id: `aup_${ulid().toLowerCase()}`,
					state: 'requested',
					detail: null,
					error: null,
					requestedBy: null,
					requestedAt: new Date(now).toISOString(),
					finishedAt: null
				}
			})
			.where(eq(node.id, row.id))
			.run();
		notifyNodes();
		return row.id;
	}
	return null;
}
