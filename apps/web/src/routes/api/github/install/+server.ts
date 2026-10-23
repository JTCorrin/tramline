import { context, errorResponse } from '#lib/server/api/handler.js';
import { AppError } from '#lib/server/api/errors.js';
import { loadApp } from '#lib/server/github/app.js';
import { secrets } from '#lib/server/api/handler.js';
import { db } from '#lib/server/db/index.js';
import { issueState } from '#lib/server/github/state.js';
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** The only external site these redirects may go to. */
const GITHUB = ['https://github.com'];

/** Sends the browser to GitHub to install the app, with a CSRF state for the way back. */
export const GET: RequestHandler = (event) => {
	let slug: string;
	try {
		context(event);
		const app = loadApp(db, secrets);
		if (!app) throw new AppError('conflict', 'Create the GitHub App first');
		slug = app.slug;
	} catch (error) {
		return errorResponse(error);
	}
	const state = issueState(event.cookies, event.url.protocol === 'https:');
	redirect(303, `https://github.com/apps/${slug}/installations/new?state=${state}`, {
		external: GITHUB
	});
};
