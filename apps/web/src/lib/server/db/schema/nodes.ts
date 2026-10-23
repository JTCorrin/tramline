import type { AgentHello } from '@tramline/contracts';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { timestamps } from './projects';

/** A machine running the Tramline agent. Nodes belong to the install, not an organization. */
export const node = sqliteTable('node', {
	id: text('id').primaryKey(),
	name: text('name').notNull().unique(),
	/** Which compute adapter manages it; `manual` for machines enrolled by hand. */
	adapter: text('adapter').notNull().default('manual'),
	/** sha256 of the agent's bearer token. */
	tokenHash: text('token_hash').notNull().unique(),
	/** Last hello from the agent. */
	info: text('info', { mode: 'json' }).$type<AgentHello>(),
	/** e.g. "Docker isn't running". */
	error: text('error'),
	lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
	/** Desired-state revision the agent last converged to. */
	revision: text('revision'),
	...timestamps
});

/** Containers as last reported by a node's agent. Replaced wholesale on every report. */
export const container = sqliteTable(
	'container',
	{
		name: text('name').primaryKey(),
		nodeId: text('node_id')
			.notNull()
			.references(() => node.id, { onDelete: 'cascade' }),
		deploymentId: text('deployment_id').notNull(),
		replica: integer('replica').notNull(),
		state: text('state', {
			enum: ['pulling', 'starting', 'running', 'restarting', 'exited', 'error']
		}).notNull(),
		healthy: integer('healthy', { mode: 'boolean' }),
		exitCode: integer('exit_code'),
		restartCount: integer('restart_count').notNull().default(0),
		error: text('error'),
		startedAt: integer('started_at', { mode: 'timestamp_ms' }),
		updatedAt: timestamps.updatedAt
	},
	(table) => [index('container_deployment_idx').on(table.deploymentId)]
);
