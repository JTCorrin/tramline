import { context, errorResponse } from '#lib/server/api/handler.js';
import { AppError } from '#lib/server/api/errors.js';
import { db } from '#lib/server/db/index.js';
import { githubApp } from '#lib/server/db/schema/index.js';
import { checkState, issueState, rememberInstallation } from '#lib/server/github/state.js';
import { settings } from '#lib/server/settings.server.js';
import { isRedirect, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * GitHub redirects here after the app is installed, when it doesn't ask who
 * installed it (apps created before Tramline asked for that). Before the
 * installation is connected, the browser goes through GitHub's user
 * authorization so Tramline can check who you are; see /api/github/callback.
 */
export const GET: RequestHandler = async (event) => {
	const installationId = event.url.searchParams.get('installation_id');
	const state = event.url.searchParams.get('state');
	let authorize: string;
	try {
		context(event);
		// edits made later on GitHub come back without our state; nothing to connect then
		if (!installationId || !state) redirect(303, '/settings');
		checkState(event.cookies, state);
		const app = db.select().from(githubApp).get();
		if (!app) throw new AppError('conflict', 'Create the GitHub App first');
		const secure = event.url.protocol === 'https:';
		rememberInstallation(event.cookies, installationId, secure);
		const url = (settings.publicUrl ?? event.url.origin).replace(/\/$/, '');
		authorize =
			'https://github.com/login/oauth/authorize?' +
			new URLSearchParams({
				client_id: app.clientId,
				state: issueState(event.cookies, secure),
				redirect_uri: `${url}/api/github/callback`
			});
	} catch (error) {
		if (isRedirect(error)) throw error;
		return errorResponse(error);
	}
	redirect(303, authorize, { external: ['https://github.com'] });
};
