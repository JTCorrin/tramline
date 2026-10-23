import type { NodeSummary } from '@tramline/contracts';
import { asc } from 'drizzle-orm';
import { node } from '../db/schema';
import { nodeStatus } from '../nodes/registry';
import type { Ctx } from './context';

/** Nodes are shared by every organization on the install. */
export function list(ctx: Ctx): NodeSummary[] {
	return ctx.db
		.select()
		.from(node)
		.orderBy(asc(node.createdAt))
		.all()
		.map((row) => ({
			id: row.id,
			name: row.name,
			status: nodeStatus(row),
			error: row.error,
			lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
			hostname: row.info?.hostname ?? null,
			dockerVersion: row.info?.docker?.version ?? null
		}));
}
