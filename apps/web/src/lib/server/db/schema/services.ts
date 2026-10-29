import { sql } from 'drizzle-orm';
import type { ScanResult, ServiceConfig, ServiceConfigPatch } from '@tramline/contracts';
import {
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';
import { user } from './auth';
import { node } from './nodes';
import { project, timestamps } from './projects';

export const environment = sqliteTable(
	'environment',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => project.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		createdAt: timestamps.createdAt
	},
	(table) => [uniqueIndex('environment_project_name_uidx').on(table.projectId, table.name)]
);

export const service = sqliteTable(
	'service',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => project.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		kind: text('kind', { enum: ['image', 'repo', 'database', 'empty'] }).notNull(),
		icon: text('icon'),
		positionX: real('position_x').notNull().default(0),
		positionY: real('position_y').notNull().default(0),
		...timestamps
	},
	(table) => [uniqueIndex('service_project_name_uidx').on(table.projectId, table.name)]
);

/** A service's configuration in one environment, as of its last deploy. */
export const serviceInstance = sqliteTable(
	'service_instance',
	{
		serviceId: text('service_id')
			.notNull()
			.references(() => service.id, { onDelete: 'cascade' }),
		environmentId: text('environment_id')
			.notNull()
			.references(() => environment.id, { onDelete: 'cascade' }),
		/** null until the first deploy. */
		config: text('config', { mode: 'json' }).$type<ServiceConfig>(),
		/** Hostname generated the first time a public domain is enabled; kept across deploys. */
		domain: text('domain').unique(),
		/** Edge port of its TCP proxy, assigned the first time one is deployed; kept after. */
		tcpPort: integer('tcp_port').unique()
	},
	(table) => [primaryKey({ columns: [table.serviceId, table.environmentId] })]
);

/** Applied variables. `service_id` null means shared across the environment. Values are encrypted. */
export const variable = sqliteTable(
	'variable',
	{
		id: text('id').primaryKey(),
		environmentId: text('environment_id')
			.notNull()
			.references(() => environment.id, { onDelete: 'cascade' }),
		serviceId: text('service_id').references(() => service.id, { onDelete: 'cascade' }),
		/** `service_id`, or `shared`; lets the unique index cover shared variables. */
		scope: text('scope').notNull(),
		key: text('key').notNull(),
		value: text('value').notNull(),
		...timestamps
	},
	(table) => [
		uniqueIndex('variable_scope_key_uidx').on(table.environmentId, table.scope, table.key)
	]
);

/**
 * Keys whose values are write-only. A seal applies to the key in its scope,
 * whether the value is deployed or only staged, and goes away with the key.
 */
export const sealedVariable = sqliteTable(
	'sealed_variable',
	{
		environmentId: text('environment_id')
			.notNull()
			.references(() => environment.id, { onDelete: 'cascade' }),
		serviceId: text('service_id').references(() => service.id, { onDelete: 'cascade' }),
		/** `service_id`, or `shared`. */
		scope: text('scope').notNull(),
		key: text('key').notNull(),
		createdAt: timestamps.createdAt
	},
	(table) => [primaryKey({ columns: [table.environmentId, table.scope, table.key] })]
);

export interface StagedPayload {
	/** The service was created and has not been deployed in this environment yet. */
	create?: boolean;
	config?: ServiceConfigPatch;
	/** Values are encrypted. */
	variables?: { set: Record<string, string>; unset: string[] };
}

/**
 * Pending, not yet deployed edits to one service (or the shared variables)
 * in one environment. Deploying applies and clears them.
 */
export const stagedChange = sqliteTable(
	'staged_change',
	{
		id: text('id').primaryKey(),
		environmentId: text('environment_id')
			.notNull()
			.references(() => environment.id, { onDelete: 'cascade' }),
		serviceId: text('service_id').references(() => service.id, { onDelete: 'cascade' }),
		/** `service_id`, or `shared`. */
		scope: text('scope').notNull(),
		payload: text('payload', { mode: 'json' }).$type<StagedPayload>().notNull(),
		...timestamps
	},
	(table) => [uniqueIndex('staged_change_scope_uidx').on(table.environmentId, table.scope)]
);

export const deployment = sqliteTable(
	'deployment',
	{
		id: text('id').primaryKey(),
		serviceId: text('service_id')
			.notNull()
			.references(() => service.id, { onDelete: 'cascade' }),
		environmentId: text('environment_id')
			.notNull()
			.references(() => environment.id, { onDelete: 'cascade' }),
		status: text('status', {
			enum: ['queued', 'building', 'deploying', 'active', 'failed', 'crashed', 'removed']
		}).notNull(),
		/** Immutable snapshot of the config this deployment runs. */
		config: text('config', { mode: 'json' }).$type<ServiceConfig>().notNull(),
		/** Encrypted JSON of the fully resolved variables. */
		variables: text('variables').notNull(),
		/**
		 * Variables whose values came from a sealed variable, directly or through a
		 * reference, when this snapshot was taken; their values are kept out of logs.
		 */
		sensitiveKeys: text('sensitive_keys', { mode: 'json' })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		/** Where it builds, and where its replicas run unless `replicaNodes` spreads them. */
		nodeId: text('node_id').references(() => node.id, { onDelete: 'set null' }),
		/**
		 * The node of each replica, by index, when they are spread across nodes;
		 * null when every replica runs on `nodeId`. The first is always `nodeId`.
		 */
		replicaNodes: text('replica_nodes', { mode: 'json' }).$type<string[]>(),
		/** Why it is in its current status, shown in the UI. */
		message: text('message'),
		/** When the current stage (build, then deploy) started; timeouts count from here, not from queueing. */
		startedAt: integer('started_at', { mode: 'timestamp_ms' }),
		/** The image to run when it isn't the configured one: a built image, or a pinned digest. */
		image: text('image'),
		/** `repo@sha256:…` observed when the image was first pulled; rollbacks reuse it. */
		resolvedImage: text('resolved_image'),
		/** The commit built, for source deployments. */
		commit: text('commit'),
		/** Vulnerability scan of the image this deployment runs. */
		scan: text('scan', { mode: 'json' }).$type<ScanResult>(),
		...timestamps
	},
	(table) => [index('deployment_instance_idx').on(table.serviceId, table.environmentId)]
);

/**
 * A service's persistent volume in one environment, on the node that holds
 * its data. Outlives the service: when the service or environment is deleted
 * its ids are cleared, and the row stays until the node reports the Docker
 * volume gone.
 */
export const volume = sqliteTable(
	'volume',
	{
		id: text('id').primaryKey(),
		serviceId: text('service_id').references(() => service.id, { onDelete: 'set null' }),
		environmentId: text('environment_id').references(() => environment.id, {
			onDelete: 'set null'
		}),
		/** Where the data lives; deployments of the service are pinned to this node. */
		nodeId: text('node_id').references(() => node.id, { onDelete: 'set null' }),
		backupSchedule: text('backup_schedule', { enum: ['off', 'daily', 'weekly'] })
			.notNull()
			.default('off'),
		/** Scheduled backups kept; older ones are deleted. */
		backupRetention: integer('backup_retention').notNull().default(7),
		...timestamps
	},
	(table) => [uniqueIndex('volume_instance_idx').on(table.serviceId, table.environmentId)]
);

/**
 * A user's own domain for a service in one environment. Hostnames are unique
 * across the install, and traffic is only routed once a TXT record proves
 * ownership, so nobody can claim a domain they don't control.
 */
export const customDomain = sqliteTable('custom_domain', {
	id: text('id').primaryKey(),
	serviceId: text('service_id')
		.notNull()
		.references(() => service.id, { onDelete: 'cascade' }),
	environmentId: text('environment_id')
		.notNull()
		.references(() => environment.id, { onDelete: 'cascade' }),
	hostname: text('hostname').notNull().unique(),
	/** Expected in the `_tramline.<hostname>` TXT record. */
	token: text('token').notNull(),
	status: text('status', { enum: ['pending', 'verified'] }).notNull(),
	error: text('error'),
	checkedAt: integer('checked_at', { mode: 'timestamp_ms' }),
	verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }),
	...timestamps
});

/** One run of a cron service's deployment: a container started on schedule that runs to completion. */
export const cronRun = sqliteTable(
	'cron_run',
	{
		id: text('id').primaryKey(),
		deploymentId: text('deployment_id')
			.notNull()
			.references(() => deployment.id, { onDelete: 'cascade' }),
		trigger: text('trigger', { enum: ['schedule', 'manual'] }).notNull(),
		status: text('status', { enum: ['running', 'succeeded', 'failed', 'skipped'] }).notNull(),
		exitCode: integer('exit_code'),
		error: text('error'),
		/** The schedule's minute this run belongs to. */
		scheduledFor: integer('scheduled_for', { mode: 'timestamp_ms' }).notNull(),
		finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
		...timestamps
	},
	(table) => [index('cron_run_deployment_idx').on(table.deploymentId)]
);
