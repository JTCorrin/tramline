import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { TokenScope } from '@tramline/contracts';
import { organization, user } from './auth';
import { timestamps } from './projects';

/** An API token. Only its SHA-256 hash is stored; it acts as the member who created it. */
export const apiToken = sqliteTable('api_token', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id')
		.notNull()
		.references(() => organization.id, { onDelete: 'cascade' }),
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	prefix: text('prefix').notNull(),
	tokenHash: text('token_hash').notNull().unique(),
	scopes: text('scopes', { mode: 'json' }).$type<TokenScope[]>().notNull(),
	expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
	lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
	...timestamps
});

/** Every change made through the API, kept for a while. */
export const auditEvent = sqliteTable(
	'audit_event',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		organizationId: text('organization_id')
			.notNull()
			.references(() => organization.id, { onDelete: 'cascade' }),
		userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
		/** Kept after the token is revoked, so the log still says which token it was. */
		tokenId: text('token_id'),
		tokenName: text('token_name'),
		action: text('action').notNull(),
		params: text('params', { mode: 'json' }).$type<Record<string, string>>().notNull(),
		status: integer('status').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(table) => [index('audit_event_org_idx').on(table.organizationId, table.createdAt)]
);

/** A repository whose GitHub Actions workflows may exchange OIDC tokens for short-lived API tokens. */
export const oidcTrust = sqliteTable('oidc_trust', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id')
		.notNull()
		.references(() => organization.id, { onDelete: 'cascade' }),
	/** The tokens it issues act as this member. */
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	repository: text('repository').notNull(),
	repositoryId: text('repository_id'),
	refPattern: text('ref_pattern'),
	environment: text('environment'),
	scopes: text('scopes', { mode: 'json' }).$type<TokenScope[]>().notNull(),
	lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
	...timestamps
});
