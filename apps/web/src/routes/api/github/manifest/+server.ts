import { context, errorResponse } from '#lib/server/api/handler.js';
import { completeManifest } from '#lib/server/github/app.js';
import { checkState, issueState } from '#lib/server/github/state.js';
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** The only external site these redirects may go to. */
const GITHUB = ['https://github.com'];

/** GitHub redirects here after the app is created; continue straight to installing it. */
export const GET: RequestHandler = async (event) => {
	let slug: string;
	try {
		const ctx = context(event);
		checkState(event.cookies, event.url.searchParams.get('state'));
		({ slug } = await completeManifest(ctx, event.url.searchParams.get('code') ?? ''));
	} catch (error) {
		return errorResponse(error);
	}
	const state = issueState(event.cookies, event.url.protocol === 'https:');
	redirect(303, `https://github.com/apps/${slug}/installations/new?state=${state}`, {
		external: GITHUB
	});
};
