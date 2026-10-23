import { context, errorResponse } from '#lib/server/api/handler.js';
import { connectInstallation } from '#lib/server/github/app.js';
import { checkState } from '#lib/server/github/state.js';
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** GitHub redirects here after the app is installed or its repository access changes. */
export const GET: RequestHandler = async (event) => {
	const installationId = event.url.searchParams.get('installation_id');
	const state = event.url.searchParams.get('state');
	try {
		const ctx = context(event);
		// edits made later on GitHub come back without our state; nothing to connect then
		if (installationId && state) {
			checkState(event.cookies, state);
			await connectInstallation(ctx, installationId);
		}
	} catch (error) {
		return errorResponse(error);
	}
	redirect(303, '/settings?github=connected');
};
