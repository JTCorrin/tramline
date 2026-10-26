import { z } from 'zod';

/**
 * What an API token may do. `read` covers every GET; `write` stages changes
 * (and implies read); `deploy` applies them and deletes things that run:
 * deploys, redeploys, restores, runs, and deleting services, environments,
 * projects, domains and backups (and implies read). A token without `deploy`
 * can stage and discard staged changes, but changes nothing that is running.
 */
export const TOKEN_SCOPES = ['read', 'write', 'deploy'] as const;
export const TokenScope = z.enum(TOKEN_SCOPES);
export type TokenScope = z.infer<typeof TokenScope>;

export const ApiToken = z.object({
	id: z.string(),
	name: z.string(),
	/** The start of the token, to recognise it. */
	prefix: z.string(),
	scopes: z.array(TokenScope),
	/** Who created it; the token acts as them. */
	createdBy: z.object({ id: z.string(), name: z.string() }),
	expiresAt: z.iso.datetime().nullable(),
	lastUsedAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime()
});

export type ApiToken = z.infer<typeof ApiToken>;

export const CreateApiToken = z.object({
	name: z.string().trim().min(1, 'Name is required').max(60),
	scopes: z.array(TokenScope).min(1, 'Choose at least one scope'),
	/** Days until it expires; null never expires. */
	expiresInDays: z.number().int().min(1).max(365).nullable()
});

export type CreateApiToken = z.infer<typeof CreateApiToken>;

/** Returned once, when the token is created; Tramline only keeps its hash. */
export const CreatedApiToken = ApiToken.extend({ token: z.string() });
export type CreatedApiToken = z.infer<typeof CreatedApiToken>;

/** A change made through the API, by a person or a token. */
export const AuditEvent = z.object({
	id: z.number().int(),
	/** e.g. `POST environments/[id]/deploy`. */
	action: z.string(),
	params: z.record(z.string(), z.string()),
	status: z.number().int(),
	user: z.object({ id: z.string(), name: z.string() }).nullable(),
	token: z.object({ id: z.string(), name: z.string() }).nullable(),
	createdAt: z.iso.datetime()
});

export type AuditEvent = z.infer<typeof AuditEvent>;

/**
 * Lets GitHub Actions workflows in a repository exchange their OIDC token for
 * a short-lived API token, so CI needs no stored secret.
 */
export const OidcTrust = z.object({
	id: z.string(),
	/** `owner/repo`. */
	repository: z.string(),
	/** Pinned on first use, so a deleted and re-created repository can't take over. */
	repositoryId: z.string().nullable(),
	/** Which refs may exchange, e.g. `refs/heads/main` or `refs/tags/v*`; null for any. */
	refPattern: z.string().nullable(),
	/** A GitHub deployment environment the job must run in; null for any. */
	environment: z.string().nullable(),
	scopes: z.array(TokenScope),
	createdBy: z.object({ id: z.string(), name: z.string() }),
	lastUsedAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime()
});

export type OidcTrust = z.infer<typeof OidcTrust>;

export const CreateOidcTrust = z.object({
	repository: z
		.string()
		.trim()
		.toLowerCase()
		.regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/, 'Use owner/repository'),
	refPattern: z
		.string()
		.trim()
		.regex(/^refs\/(heads|tags|pull)\/\S+$/, 'Use a full ref, like refs/heads/main')
		.nullable(),
	environment: z.string().trim().min(1).max(255).nullable(),
	scopes: z.array(TokenScope).min(1, 'Choose at least one scope')
});

export type CreateOidcTrust = z.infer<typeof CreateOidcTrust>;

/** What a workflow gets back for its OIDC token. */
export const OidcExchange = z.object({
	token: z.string(),
	expiresAt: z.iso.datetime(),
	scopes: z.array(TokenScope)
});

export type OidcExchange = z.infer<typeof OidcExchange>;
