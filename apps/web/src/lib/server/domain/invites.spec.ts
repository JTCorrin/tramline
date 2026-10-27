import { and, eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { member, user } from '../db/schema';
import { grantInstallAdmin, seedCtx } from '../testing';
import * as invites from './invites';

function setup() {
	const ctx = seedCtx();
	ctx.settings = { ...ctx.settings, dataDir: mkdtempSync(path.join(tmpdir(), 'tl-inv-')) };
	return ctx;
}

/** A person who signed up, but belongs to no organization yet. */
function newcomer(ctx: ReturnType<typeof seedCtx>) {
	const id = `user_new_${Math.random().toString(36).slice(2)}`;
	ctx.db
		.insert(user)
		.values({ id, name: 'New', email: `${id}@example.com` })
		.run();
	return id;
}

const tokenOf = (url: string) => url.split('/invite/')[1]!;

describe('invites', () => {
	it('are created by owners and admins only, never through API tokens', () => {
		const ctx = setup();
		const invite = invites.create(ctx, { role: 'member' }, 'http://tramline.test');
		expect(invite.url).toMatch(/^http:\/\/localhost:5173\/invite\/tlinv_/);
		expect(invites.list(ctx).map((i) => i.id)).toEqual([invite.id]);

		const viaToken = { ...ctx, token: { id: 't', name: 'ci', scopes: ['deploy' as const] } };
		expect(() => invites.create(viaToken, { role: 'member' }, 'http://x')).toThrow('Sign in');

		const outsider = seedCtx(ctx.db);
		ctx.db.update(member).set({ role: 'member' }).where(eq(member.userId, outsider.userId)).run();
		expect(() => invites.create(outsider, { role: 'member' }, 'http://x')).toThrow(
			'Only organization owners and admins'
		);
	});

	it('join someone to the organization once, with the invite’s role', () => {
		const ctx = setup();
		const { url } = invites.create(ctx, { role: 'admin' }, 'http://x');
		const someone = newcomer(ctx);
		expect(invites.redeem(ctx.db, tokenOf(url), someone)).toBe(ctx.organizationId);
		expect(
			ctx.db
				.select({ role: member.role })
				.from(member)
				.where(and(eq(member.userId, someone), eq(member.organizationId, ctx.organizationId)))
				.get()
		).toEqual({ role: 'admin' });
		expect(() => invites.redeem(ctx.db, tokenOf(url), newcomer(ctx))).toThrow(
			'used or has expired'
		);
		expect(invites.list(ctx)).toEqual([]);
	});

	it('expire, and can be revoked', () => {
		const ctx = setup();
		const past = new Date(Date.now() - 2 * invites.INVITE_TTL_MS);
		const old = invites.create(ctx, { role: 'member' }, 'http://x', past);
		expect(invites.findInvite(ctx.db, tokenOf(old.url))).toBeUndefined();

		const fresh = invites.create(ctx, { role: 'member' }, 'http://x');
		invites.revoke(ctx, fresh.id);
		expect(invites.findInvite(ctx.db, tokenOf(fresh.url))).toBeUndefined();
		expect(() => invites.revoke(ctx, fresh.id)).toThrow('Invite');
	});
});

describe('sign-up policy', () => {
	it('is open until the install has an admin, then needs an invite', () => {
		const ctx = setup();
		const settings = { signup: 'invite' as const };
		expect(invites.signupAllowed(ctx.db, settings, null)).toBe(true);

		grantInstallAdmin(ctx);
		expect(invites.signupAllowed(ctx.db, settings, null)).toBe(false);
		expect(invites.signupAllowed(ctx.db, settings, 'tlinv_made_up')).toBe(false);
		const { url } = invites.create(ctx, { role: 'member' }, 'http://x');
		expect(invites.signupAllowed(ctx.db, settings, tokenOf(url))).toBe(true);

		// TRAMLINE_SIGNUP=open lets anyone in
		expect(invites.signupAllowed(ctx.db, { signup: 'open' }, null)).toBe(true);
	});
});
