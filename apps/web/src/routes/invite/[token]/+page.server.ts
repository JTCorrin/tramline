import { auth } from '#lib/server/auth.js';
import { db } from '#lib/server/db/index.js';
import { organization } from '#lib/server/db/schema/index.js';
import { findInvite, INVITE_COOKIE, INVITE_TTL_MS, redeem } from '#lib/server/domain/invites.js';
import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';

/**
 * An invite link. Signed in, it asks you to confirm joining the organization:
 * opening a link must not be enough, or any site could send you through one
 * and add you to an organization of its choosing. Otherwise it's remembered
 * in a cookie through sign-up (or GitHub sign-in), where the account is
 * created and joined to the organization.
 */
export const load: PageServerLoad = async ({ params, locals, cookies }) => {
	const invite = findInvite(db, params.token);
	if (!invite) return { valid: false as const };
	if (locals.user) {
		const org = db
			.select({ name: organization.name })
			.from(organization)
			.where(eq(organization.id, invite.organizationId))
			.get();
		return {
			valid: true as const,
			organization: org?.name ?? 'an organization',
			role: invite.role
		};
	}
	cookies.set(INVITE_COOKIE, params.token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: INVITE_TTL_MS / 1000
	});
	redirect(303, '/sign-up');
};

export const actions: Actions = {
	// SvelteKit refuses form posts from other origins, so only a click here joins
	default: async ({ params, locals, request }) => {
		if (!locals.user) redirect(303, `/invite/${params.token}`);
		if (!findInvite(db, params.token)) return fail(410, { error: 'expired' });
		const organizationId = redeem(db, params.token, locals.user.id);
		await auth.api.setActiveOrganization({ headers: request.headers, body: { organizationId } });
		redirect(303, '/');
	}
};
