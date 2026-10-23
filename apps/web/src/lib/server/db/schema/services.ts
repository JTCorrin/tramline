import type { ServiceConfig, ServiceConfigPatch } from '@tramline/contracts';
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
		domain: text('domain').unique()
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
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		nodeId: text('node_id').references(() => node.id, { onDelete: 'set null' }),
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
		...timestamps
	},
	(table) => [index('deployment_instance_idx').on(table.serviceId, table.environmentId)]
);
