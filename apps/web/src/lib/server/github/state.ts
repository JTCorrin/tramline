import type { Cookies } from '@sveltejs/kit';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../api/errors';

/**
 * CSRF protection for the GitHub redirects: a random value stored in a
 * cookie must come back as `?state=`.
 */
const COOKIE = 'tramline_github_state';

export function issueState(cookies: Cookies, secure: boolean) {
	const state = randomBytes(24).toString('base64url');
	cookies.set(COOKIE, state, {
		path: '/api/github',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		maxAge: 3600
	});
	return state;
}

export function checkState(cookies: Cookies, state: string | null) {
	const expected = cookies.get(COOKIE);
	const valid =
		!!state &&
		!!expected &&
		state.length === expected.length &&
		timingSafeEqual(Buffer.from(state), Buffer.from(expected));
	if (!valid)
		throw new AppError('forbidden', 'This GitHub link has expired; start again from Settings');
}

/** The installation waiting for its installer's authorization, between two redirects. */
const PENDING = 'tramline_github_installation';

export function rememberInstallation(cookies: Cookies, installationId: string, secure: boolean) {
	cookies.set(PENDING, installationId, {
		path: '/api/github',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		maxAge: 900
	});
}

export function pendingInstallation(cookies: Cookies) {
	const id = cookies.get(PENDING) ?? null;
	cookies.delete(PENDING, { path: '/api/github' });
	return id;
}
