import { z } from 'zod';

/**
 * What an API token may do. `read` covers every GET; `write` stages changes
 * (and implies read); `deploy` applies them: deploys, redeploys, restores and
 * runs (and implies read). A token without `deploy` can only stage.
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
