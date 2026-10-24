import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { organization, user } from './auth';
import { node } from './nodes';
import { timestamps } from './projects';
import { volume } from './services';

/** An organization's S3-compatible bucket for backups. The secret key is encrypted. */
export const backupStorage = sqliteTable('backup_storage', {
	organizationId: text('organization_id')
		.primaryKey()
		.references(() => organization.id, { onDelete: 'cascade' }),
	endpoint: text('endpoint').notNull(),
	region: text('region').notNull(),
	bucket: text('bucket').notNull(),
	prefix: text('prefix').notNull(),
	accessKeyId: text('access_key_id').notNull(),
	secretAccessKey: text('secret_access_key').notNull(),
	pathStyle: integer('path_style', { mode: 'boolean' }).notNull(),
	...timestamps
});

const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;

/**
 * One backup of a volume. The object in the bucket is encrypted with a
 * per-backup key, stored here wrapped with the install's secret key.
 */
export const backup = sqliteTable(
	'backup',
	{
		id: text('id').primaryKey(),
		volumeId: text('volume_id')
			.notNull()
			.references(() => volume.id, { onDelete: 'cascade' }),
		organizationId: text('organization_id')
			.notNull()
			.references(() => organization.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: ['postgres', 'mysql', 'mongo', 'volume'] }).notNull(),
		trigger: text('trigger', { enum: ['manual', 'scheduled'] }).notNull(),
		status: text('status', { enum: JOB_STATUSES }).notNull(),
		/** Where the encrypted backup lives in the organization's bucket. */
		objectKey: text('object_key').notNull(),
		/** The per-backup AES-256 key, encrypted with TRAMLINE_SECRET_KEY. */
		wrappedKey: text('wrapped_key').notNull(),
		size: integer('size'),
		error: text('error'),
		nodeId: text('node_id').references(() => node.id, { onDelete: 'set null' }),
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
		...timestamps
	},
	(table) => [index('backup_volume_idx').on(table.volumeId)]
);

/** Restoring a backup into its volume. */
export const restore = sqliteTable(
	'restore',
	{
		id: text('id').primaryKey(),
		backupId: text('backup_id')
			.notNull()
			.references(() => backup.id, { onDelete: 'cascade' }),
		status: text('status', { enum: JOB_STATUSES }).notNull(),
		error: text('error'),
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
		...timestamps
	},
	(table) => [index('restore_backup_idx').on(table.backupId)]
);
