import type {
	ApiToken,
	AuditEvent,
	CreateApiToken,
	CreatedApiToken,
	TokenScope
} from '@tramline/contracts';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { AppError, notFound } from '../api/errors';
import type { DbOrTx } from '../db/client';
import { apiToken, auditEvent, member, user } from '../db/schema';
import { newId } from '../ids';
import { isManager } from './access';
import type { Ctx } from './context';

type Row = typeof apiToken.$inferSelect;

export const TOKEN_PREFIX = 'tl_';
/** `lastUsedAt` is updated at most this often, so busy tokens don't write on every request. */
const LAST_USED_RESOLUTION_MS = 60_000;
/** Audit events are kept this long. */
export const AUDIT_RETENTION_MS = 90 * 24 * 3600_000;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Whether a token's scopes allow `scope`; write and deploy each include read. */
export function allows(scopes: TokenScope[], scope: TokenScope) {
	return scopes.includes(scope) || (scope === 'read' && scopes.length > 0);
}

function dto(row: Row, creator: { id: string; name: string }): ApiToken {
	return {
		id: row.id,
		name: row.name,
		prefix: row.prefix,
		scopes: row.scopes,
		createdBy: creator,
		expiresAt: row.expiresAt?.toISOString() ?? null,
		lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString()
	};
}

/** Creates a token for the caller. The secret is returned now and never again. */
export function create(ctx: Ctx, input: CreateApiToken, now = new Date()): CreatedApiToken {
	const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
	const row = ctx.db
		.insert(apiToken)
		.values({
			id: newId('token'),
			organizationId: ctx.organizationId,
			userId: ctx.userId,
			name: input.name,
			prefix: token.slice(0, TOKEN_PREFIX.length + 6),
			tokenHash: hashToken(token),
			scopes: [...new Set(input.scopes)],
			expiresAt: input.expiresInDays
				? new Date(now.getTime() + input.expiresInDays * 86_400_000)
				: null
		})
		.returning()
		.get();
	const creator = ctx.db
		.select({ id: user.id, name: user.name })
		.from(user)
		.where(eq(user.id, ctx.userId))
		.get()!;
	return { ...dto(row, creator), token };
}

/** The caller's tokens; owners and admins see everyone's in the organization. */
export function list(ctx: Ctx): ApiToken[] {
	const all = isManager(ctx);
	return ctx.db
		.select({ token: apiToken, creator: { id: user.id, name: user.name } })
		.from(apiToken)
		.innerJoin(user, eq(apiToken.userId, user.id))
		.where(
			all
				? eq(apiToken.organizationId, ctx.organizationId)
				: and(eq(apiToken.organizationId, ctx.organizationId), eq(apiToken.userId, ctx.userId))
		)
		.orderBy(desc(apiToken.createdAt))
		.all()
		.map((row) => dto(row.token, row.creator));
}

/** Revokes a token at once. Your own, or anyone's if you are an owner or admin. */
export function revoke(ctx: Ctx, id: string) {
	const row = ctx.db
		.select()
		.from(apiToken)
		.where(and(eq(apiToken.id, id), eq(apiToken.organizationId, ctx.organizationId)))
		.get();
	if (!row || (row.userId !== ctx.userId && !isManager(ctx))) throw notFound('Token');
	ctx.db.delete(apiToken).where(eq(apiToken.id, id)).run();
}

/**
 * The token a bearer secret belongs to, if it is valid: not expired, and its
 * creator still a member of the organization.
 */
export function authenticate(db: DbOrTx, secret: string, now = new Date()) {
	if (!secret.startsWith(TOKEN_PREFIX)) return null;
	const row = db
		.select()
		.from(apiToken)
		.where(eq(apiToken.tokenHash, hashToken(secret)))
		.get();
	if (!row) return null;
	if (row.expiresAt && row.expiresAt <= now) {
		throw new AppError('unauthenticated', 'This token has expired');
	}
	const stillMember = db
		.select({ id: member.id })
		.from(member)
		.where(and(eq(member.organizationId, row.organizationId), eq(member.userId, row.userId)))
		.get();
	if (!stillMember) return null;
	if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
		db.update(apiToken).set({ lastUsedAt: now }).where(eq(apiToken.id, row.id)).run();
	}
	return row;
}

// ---- audit log -----------------------------------------------------------------

export function record(
	db: DbOrTx,
	ctx: Pick<Ctx, 'organizationId' | 'userId' | 'token'>,
	event: { action: string; params: Record<string, string>; status: number },
	now = new Date()
) {
	db.insert(auditEvent)
		.values({
			organizationId: ctx.organizationId,
			userId: ctx.userId,
			tokenId: ctx.token?.id ?? null,
			tokenName: ctx.token?.name ?? null,
			...event,
			createdAt: now
		})
		.run();
}

/** The organization's recent changes, for owners and admins. */
export function auditLog(ctx: Ctx, limit = 100): AuditEvent[] {
	if (!isManager(ctx))
		throw new AppError('forbidden', 'Only organization owners and admins can read the audit log');
	const rows = ctx.db
		.select()
		.from(auditEvent)
		.where(eq(auditEvent.organizationId, ctx.organizationId))
		.orderBy(desc(auditEvent.id))
		.limit(limit)
		.all();
	const ids = [...new Set(rows.map((r) => r.userId).filter((id) => id !== null))];
	const names = new Map(
		ids.length
			? ctx.db
					.select({ id: user.id, name: user.name })
					.from(user)
					.where(inArray(user.id, ids))
					.all()
					.map((u) => [u.id, u.name])
			: []
	);
	return rows.map((row) => ({
		id: row.id,
		action: row.action,
		params: row.params,
		status: row.status,
		user: row.userId ? { id: row.userId, name: names.get(row.userId) ?? 'Deleted user' } : null,
		token: row.tokenId ? { id: row.tokenId, name: row.tokenName ?? '' } : null,
		createdAt: row.createdAt.toISOString()
	}));
}

/** Drops audit events older than the retention period. */
export function pruneAuditLog(db: DbOrTx, now = new Date()) {
	db.delete(auditEvent)
		.where(lt(auditEvent.createdAt, new Date(now.getTime() - AUDIT_RETENTION_MS)))
		.run();
}
