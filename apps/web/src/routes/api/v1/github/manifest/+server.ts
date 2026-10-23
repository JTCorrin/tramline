import { endpoint } from '#lib/server/api/handler.js';
import { manifestForm } from '#lib/server/github/app.js';
import { issueState } from '#lib/server/github/state.js';
import { settings } from '#lib/server/settings.server.js';
import { z } from 'zod';

const Body = z.object({ owner: z.string().trim().max(100).nullable().optional() });

/** Starts the manifest flow: returns the form the browser posts to GitHub. */
export const POST = endpoint(async (ctx, event) => {
	const { owner } = Body.parse(await event.request.json().catch(() => ({})));
	const state = issueState(event.cookies, event.url.protocol === 'https:');
	return manifestForm(ctx, settings, state, owner || null);
});
