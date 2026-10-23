import { auth } from '#lib/server/auth.js';
import { db } from '#lib/server/db/index.js';
import { organizations } from '#lib/server/domain/index.js';
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, request }) => {
	if (!locals.user || !locals.session) redirect(303, '/sign-in');

	const orgs = organizations.listForUser(db, locals.user.id);
	if (orgs.length === 0) redirect(303, '/onboarding');

	let activeId = locals.session.activeOrganizationId;
	if (!orgs.some((org) => org.id === activeId)) {
		activeId = orgs[0]!.id;
		await auth.api.setActiveOrganization({
			headers: request.headers,
			body: { organizationId: activeId }
		});
	}

	return {
		user: {
			id: locals.user.id,
			name: locals.user.name,
			email: locals.user.email,
			image: locals.user.image ?? null
		},
		organizations: orgs,
		activeOrganization: orgs.find((org) => org.id === activeId)!
	};
};
