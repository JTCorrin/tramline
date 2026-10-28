import { asc, count, eq } from 'drizzle-orm';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError, notFound } from '../api/errors';
import type { DbOrTx } from '../db/client';
import { installAdmin, user } from '../db/schema';
import type { Ctx } from './context';

/**
 * Install admins manage the machines every organization runs on, so being
 * one is an explicit, stored grant to a person: never inferred from an email
 * address (Tramline doesn't verify those) or from signing up first. The
 * first admin claims the install with a one-time setup token that only the
 * operator can read; later ones are granted by an existing admin.
 */

export const setupTokenFile = (dataDir: string) => path.join(dataDir, 'setup-token');

export const hasAdmins = (db: DbOrTx) =>
	(db.select({ n: count() }).from(installAdmin).get()?.n ?? 0) > 0;

/**
 * While no one is an admin, keeps a setup token in `<dataDir>/setup-token`
 * (mode 600) and returns its path; once someone is, removes it.
 */
export function ensureSetupToken(db: DbOrTx, dataDir: string) {
	const file = setupTokenFile(dataDir);
	if (hasAdmins(db)) {
		rmSync(file, { force: true });
		return null;
	}
	try {
		if (readFileSync(file, 'utf8').trim()) return file;
	} catch {
		// not created yet
	}
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(file, `tlsetup_${randomBytes(24).toString('base64url')}\n`, { mode: 0o600 });
	return file;
}

export function isInstallAdmin(ctx: Ctx) {
	// API tokens act inside one organization; the install's machines are out of their reach
	if (ctx.token) return false;
	return !!ctx.db
		.select({ userId: installAdmin.userId })
		.from(installAdmin)
		.where(eq(installAdmin.userId, ctx.userId))
		.get();
}

export function requireInstallAdmin(ctx: Ctx, action: string) {
	if (!isInstallAdmin(ctx))
		throw new AppError('forbidden', `Only this install's admins can ${action}`);
}

/** Whether the install still waits for its first admin. */
export function awaitingSetup(ctx: Ctx) {
	return !hasAdmins(ctx.db);
}

/** Makes the caller the first admin, given the token from the server's data directory. */
export function claim(ctx: Ctx, token: string) {
	if (ctx.token) throw new AppError('forbidden', 'Sign in to Tramline to claim it');
	if (hasAdmins(ctx.db)) throw new AppError('conflict', 'This install already has an admin');
	let expected = '';
	try {
		expected = readFileSync(setupTokenFile(ctx.settings.dataDir), 'utf8').trim();
	} catch {
		// no token: refused below
	}
	const given = Buffer.from(token.trim());
	if (
		!expected ||
		given.length !== expected.length ||
		!timingSafeEqual(given, Buffer.from(expected))
	) {
		throw new AppError('forbidden', 'That setup token is not right');
	}
	ctx.db.insert(installAdmin).values({ userId: ctx.userId, grantedBy: null }).run();
	rmSync(setupTokenFile(ctx.settings.dataDir), { force: true });
}

export function list(ctx: Ctx) {
	requireInstallAdmin(ctx, 'see who the admins are');
	return ctx.db
		.select({
			userId: installAdmin.userId,
			name: user.name,
			email: user.email,
			grantedAt: installAdmin.grantedAt
		})
		.from(installAdmin)
		.innerJoin(user, eq(user.id, installAdmin.userId))
		.orderBy(asc(installAdmin.grantedAt))
		.all()
		.map((row) => ({ ...row, grantedAt: row.grantedAt.toISOString() }));
}

/** Makes someone who already has an account an admin. */
export function grant(ctx: Ctx, email: string) {
	requireInstallAdmin(ctx, 'add admins');
	const target = ctx.db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, email.trim().toLowerCase()))
		.get();
	if (!target) throw notFound('User');
	ctx.db
		.insert(installAdmin)
		.values({ userId: target.id, grantedBy: ctx.userId })
		.onConflictDoNothing()
		.run();
	return list(ctx);
}

export function revoke(ctx: Ctx, userId: string) {
	requireInstallAdmin(ctx, 'remove admins');
	const admins = list(ctx);
	if (!admins.some((a) => a.userId === userId)) throw notFound('Admin');
	if (admins.length === 1) throw new AppError('conflict', 'An install needs at least one admin');
	ctx.db.delete(installAdmin).where(eq(installAdmin.userId, userId)).run();
	return list(ctx);
}
