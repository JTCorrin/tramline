import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { node } from './nodes';
import { deployment, environment, service } from './services';

/**
 * Metrics in buckets: `step` is the bucket's length in seconds (60 or 3600)
 * and `bucket` its start, in epoch milliseconds. A bucket keeps sums and
 * counts, so samples fold in as they arrive and hourly buckets are rolled up
 * from minutes. Minutes are kept for two days, hours for a month.
 */

/** One workload container (a deployment's replica). */
export const containerMetric = sqliteTable(
	'container_metric',
	{
		step: integer('step').notNull(),
		bucket: integer('bucket').notNull(),
		deploymentId: text('deployment_id')
			.notNull()
			.references(() => deployment.id, { onDelete: 'cascade' }),
		replica: integer('replica').notNull(),
		serviceId: text('service_id')
			.notNull()
			.references(() => service.id, { onDelete: 'cascade' }),
		environmentId: text('environment_id')
			.notNull()
			.references(() => environment.id, { onDelete: 'cascade' }),
		samples: integer('samples').notNull(),
		/** CPU in cores × 100. */
		cpuSum: real('cpu_sum').notNull(),
		cpuMax: real('cpu_max').notNull(),
		memorySum: real('memory_sum').notNull(),
		memoryMax: real('memory_max').notNull(),
		memoryLimit: real('memory_limit'),
		rxBytes: integer('rx_bytes').notNull(),
		txBytes: integer('tx_bytes').notNull()
	},
	(table) => [
		primaryKey({ columns: [table.step, table.deploymentId, table.replica, table.bucket] }),
		index('container_metric_service').on(
			table.serviceId,
			table.environmentId,
			table.step,
			table.bucket
		)
	]
);

export const nodeMetric = sqliteTable(
	'node_metric',
	{
		step: integer('step').notNull(),
		bucket: integer('bucket').notNull(),
		nodeId: text('node_id')
			.notNull()
			.references(() => node.id, { onDelete: 'cascade' }),
		samples: integer('samples').notNull(),
		/** CPU as a share of the whole machine (0–100). */
		cpuSum: real('cpu_sum').notNull(),
		cpuMax: real('cpu_max').notNull(),
		memoryUsedSum: real('memory_used_sum').notNull(),
		memoryUsedMax: real('memory_used_max').notNull(),
		memoryTotal: real('memory_total').notNull(),
		/** The latest reading in a minute, the highest in an hour. */
		diskUsed: real('disk_used'),
		diskTotal: real('disk_total')
	},
	(table) => [primaryKey({ columns: [table.step, table.nodeId, table.bucket] })]
);

/**
 * Something that needs attention, open until its condition clears. A node's
 * alerts concern the whole install; a service's, its organization.
 */
export const alert = sqliteTable(
	'alert',
	{
		id: text('id').primaryKey(),
		kind: text('kind', {
			enum: ['node_offline', 'node_disk', 'node_memory', 'service_memory']
		}).notNull(),
		nodeId: text('node_id').references(() => node.id, { onDelete: 'cascade' }),
		serviceId: text('service_id').references(() => service.id, { onDelete: 'cascade' }),
		environmentId: text('environment_id').references(() => environment.id, {
			onDelete: 'cascade'
		}),
		message: text('message').notNull(),
		openedAt: integer('opened_at', { mode: 'timestamp_ms' }).notNull(),
		resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' })
	},
	(table) => [index('alert_open').on(table.resolvedAt, table.kind)]
);
