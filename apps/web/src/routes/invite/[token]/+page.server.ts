import { auth } from '#lib/server/auth.js';
import { db } from '#lib/server/db/index.js';
import { findInvite, INVITE_COOKIE, INVITE_TTL_MS, redeem } from '#lib/server/domain/invites.js';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * An invite link. Signed in, it joins you to the organization at once.
 * Otherwise it's remembered in a cookie through sign-up (or GitHub sign-in),
 * where the account is created and joined to the organization.
 */
export const load: PageServerLoad = async ({ params, locals, cookies, request }) => {
	if (!findInvite(db, params.token)) return { valid: false };
	if (locals.user) {
		const organizationId = redeem(db, params.token, locals.user.id);
		await auth.api.setActiveOrganization({ headers: request.headers, body: { organizationId } });
		redirect(303, '/');
	}
	cookies.set(INVITE_COOKIE, params.token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: INVITE_TTL_MS / 1000
	});
	redirect(303, '/sign-up');
};
