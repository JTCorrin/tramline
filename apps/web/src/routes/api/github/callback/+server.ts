import { context, errorResponse } from '#lib/server/api/handler.js';
import { AppError } from '#lib/server/api/errors.js';
import { connectInstallation } from '#lib/server/github/app.js';
import { checkState, pendingInstallation } from '#lib/server/github/state.js';
import { isRedirect, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * GitHub's user authorization comes back here with a one-time code: straight
 * after installing (the app asks during install), or via /api/github/setup.
 * The code shows which installations this person can access on GitHub; only
 * then is the installation connected.
 */
export const GET: RequestHandler = async (event) => {
	const params = event.url.searchParams;
	try {
		const ctx = context(event);
		// edits made later on GitHub come back without our state; nothing to connect then
		if (!params.get('state')) redirect(303, '/settings');
		checkState(event.cookies, params.get('state'));
		const installationId = params.get('installation_id') ?? pendingInstallation(event.cookies);
		const code = params.get('code');
		if (!installationId || !code) {
			throw new AppError('bad_request', 'GitHub did not say which installation to connect');
		}
		await connectInstallation(ctx, installationId, code);
	} catch (error) {
		if (isRedirect(error)) throw error;
		return errorResponse(error);
	}
	redirect(303, '/settings?github=connected');
};
