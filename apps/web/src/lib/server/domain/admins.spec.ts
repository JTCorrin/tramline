import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedCtx } from '../testing';
import * as admins from './admins';

function install() {
	const ctx = seedCtx();
	ctx.settings = { ...ctx.settings, dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-admins-')) };
	const file = admins.ensureSetupToken(ctx.db, ctx.settings.dataDir)!;
	return { ctx, file, token: readFileSync(file, 'utf8').trim() };
}

describe('install admins', () => {
	it('starts with a setup token only the operator can read, and no admin', () => {
		const { ctx, file, token } = install();
		expect(token).toMatch(/^tlsetup_/);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		// restarting keeps the same token until it's used
		expect(admins.ensureSetupToken(ctx.db, ctx.settings.dataDir)).toBe(file);
		expect(readFileSync(file, 'utf8').trim()).toBe(token);
		expect(admins.awaitingSetup(ctx)).toBe(true);
		expect(admins.isInstallAdmin(ctx)).toBe(false);
	});

	it('is claimed once, with the right token, by a signed-in person', () => {
		const { ctx, file, token } = install();
		expect(() => admins.claim(ctx, 'tlsetup_wrong')).toThrow('setup token is not right');
		expect(() =>
			admins.claim({ ...ctx, token: { id: 'tok', name: 'ci', scopes: ['deploy'] } }, token)
		).toThrow('Sign in');

		admins.claim(ctx, `  ${token}\n`);
		expect(admins.isInstallAdmin(ctx)).toBe(true);
		expect(existsSync(file)).toBe(false);
		expect(admins.ensureSetupToken(ctx.db, ctx.settings.dataDir)).toBeNull();

		const someoneElse = { ...seedCtx(ctx.db), settings: ctx.settings };
		expect(() => admins.claim(someoneElse, token)).toThrow('already has an admin');
	});

	it('admins add and remove others, but never the last one', () => {
		const { ctx, token } = install();
		admins.claim(ctx, token);
		const other = { ...seedCtx(ctx.db), settings: ctx.settings };
		expect(() => admins.grant(other, 'x@example.com')).toThrow("Only this install's admins");
		expect(() => admins.grant(ctx, 'nobody@example.com')).toThrow('User');

		const email = `user${other.userId.split('_')[1]}@example.com`;
		expect(admins.grant(ctx, email.toUpperCase()).map((a) => a.userId)).toEqual([
			ctx.userId,
			other.userId
		]);
		expect(admins.isInstallAdmin(other)).toBe(true);
		expect(admins.revoke(other, ctx.userId).map((a) => a.userId)).toEqual([other.userId]);
		expect(() => admins.revoke(other, other.userId)).toThrow('at least one admin');
		expect(() => admins.revoke(other, 'user_missing')).toThrow('Admin');
	});
});
