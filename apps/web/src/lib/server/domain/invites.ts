import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError, notFound } from '../api/errors';
import type { DbOrTx } from '../db/client';
import { member, orgInvite, user } from '../db/schema';
import { newId } from '../ids';
import type { PlatformSettings } from '../settings';
import { requireManager } from './access';
import { hasAdmins } from './admins';
import type { Ctx } from './context';

/**
 * Invite links: one-time, expiring links an organization's owners and admins
 * hand out. With sign-up by invitation (the default), they're how anyone new
 * gets an account; they also let existing users join another organization.
 */

export const INVITE_TTL_MS = 7 * 24 * 3600_000;
/** Carries an invite through sign-up, including a round trip through GitHub. */
export const INVITE_COOKIE = 'tramline_invite';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export interface Invite {
	id: string;
	role: 'member' | 'admin';
	createdBy: string | null;
	expiresAt: string;
	createdAt: string;
}

export function create(
	ctx: Ctx,
	input: { role: 'member' | 'admin' },
	origin: string,
	now = new Date()
) {
	if (ctx.token) throw new AppError('forbidden', 'Sign in to Tramline to invite people');
	requireManager(ctx, 'invite people');
	const token = `tlinv_${randomBytes(24).toString('base64url')}`;
	const row = ctx.db
		.insert(orgInvite)
		.values({
			id: newId('invite'),
			tokenHash: hash(token),
			organizationId: ctx.organizationId,
			role: input.role,
			createdBy: ctx.userId,
			expiresAt: new Date(now.getTime() + INVITE_TTL_MS)
		})
		.returning()
		.get();
	const base = (ctx.settings.publicUrl ?? origin).replace(/\/$/, '');
	return { ...toDto(row), url: `${base}/invite/${token}` };
}

const toDto = (row: typeof orgInvite.$inferSelect): Invite => ({
	id: row.id,
	role: row.role,
	createdBy: row.createdBy,
	expiresAt: row.expiresAt.toISOString(),
	createdAt: row.createdAt.toISOString()
});

/** Invites that can still be used. */
export function list(ctx: Ctx, now = new Date()) {
	requireManager(ctx, 'see invites');
	return ctx.db
		.select()
		.from(orgInvite)
		.where(
			and(
				eq(orgInvite.organizationId, ctx.organizationId),
				isNull(orgInvite.usedAt),
				gt(orgInvite.expiresAt, now)
			)
		)
		.orderBy(desc(orgInvite.createdAt))
		.all()
		.map(toDto);
}

export function revoke(ctx: Ctx, id: string) {
	requireManager(ctx, 'revoke invites');
	const removed = ctx.db
		.delete(orgInvite)
		.where(and(eq(orgInvite.id, id), eq(orgInvite.organizationId, ctx.organizationId)))
		.returning({ id: orgInvite.id })
		.get();
	if (!removed) throw notFound('Invite');
}

/** The usable invite for a token, if any. */
export function findInvite(db: DbOrTx, token: string | null | undefined, now = new Date()) {
	if (!token) return undefined;
	return db
		.select()
		.from(orgInvite)
		.where(
			and(
				eq(orgInvite.tokenHash, hash(token)),
				isNull(orgInvite.usedAt),
				gt(orgInvite.expiresAt, now)
			)
		)
		.get();
}

/**
 * Whether a new account may be created: always when sign-up is open, and
 * while the install waits for its first admin (whoever claims it needs an
 * account); otherwise only with a usable invite.
 */
export function signupAllowed(
	db: DbOrTx,
	settings: Pick<PlatformSettings, 'signup'>,
	token: string | null | undefined
) {
	if ((settings.signup ?? 'invite') === 'open') return true;
	if (!hasAdmins(db)) return true;
	return !!findInvite(db, token);
}

/** Uses an invite: the user joins its organization with its role. Returns the organization. */
export function redeem(db: DbOrTx, token: string, userId: string, now = new Date()) {
	return db.transaction((tx) => {
		const invite = findInvite(tx, token, now);
		if (!invite) throw new AppError('not_found', 'This invite link has been used or has expired');
		if (!tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).get()) {
			throw notFound('User');
		}
		const already = tx
			.select({ id: member.id })
			.from(member)
			.where(and(eq(member.organizationId, invite.organizationId), eq(member.userId, userId)))
			.get();
		if (!already) {
			tx.insert(member)
				.values({
					id: randomUUID(),
					organizationId: invite.organizationId,
					userId,
					role: invite.role,
					createdAt: now
				})
				.run();
		}
		tx.update(orgInvite)
			.set({ usedAt: now, usedBy: userId })
			.where(eq(orgInvite.id, invite.id))
			.run();
		return invite.organizationId;
	});
}
