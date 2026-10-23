import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { organization } from './auth';
import { timestamps } from './projects';

/**
 * The install's GitHub App, created through GitHub's manifest flow. There is
 * at most one row. Secrets are encrypted.
 */
export const githubApp = sqliteTable('github_app', {
	id: text('id').primaryKey(),
	slug: text('slug').notNull(),
	name: text('name').notNull(),
	htmlUrl: text('html_url').notNull(),
	owner: text('owner').notNull(),
	clientId: text('client_id').notNull(),
	clientSecret: text('client_secret').notNull(),
	privateKey: text('private_key').notNull(),
	webhookSecret: text('webhook_secret').notNull(),
	createdAt: timestamps.createdAt
});

/** An installation of the app on a GitHub account, connected to one Tramline organization. */
export const githubInstallation = sqliteTable('github_installation', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id')
		.notNull()
		.references(() => organization.id, { onDelete: 'cascade' }),
	account: text('account').notNull(),
	accountType: text('account_type').notNull(),
	htmlUrl: text('html_url').notNull(),
	createdAt: timestamps.createdAt
});
