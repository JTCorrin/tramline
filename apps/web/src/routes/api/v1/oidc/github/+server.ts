import { z } from 'zod';
import { db } from '#lib/server/db/index.js';
import { errorResponse } from '#lib/server/api/handler.js';
import { AppError } from '#lib/server/api/errors.js';
import { exchange } from '#lib/server/domain/oidc.js';
import { settings } from '#lib/server/settings.server.js';
import type { RequestHandler } from './$types';

/**
 * GitHub Actions trades its OIDC token (requested with this install's URL as
 * the audience) for a short-lived API token. No secret is stored in CI.
 */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const parsed = z
			.object({ token: z.string().min(1) })
			.safeParse(await request.json().catch(() => null));
		if (!parsed.success)
			throw new AppError('bad_request', 'Send { "token": "<GitHub Actions OIDC token>" }');
		return Response.json(await exchange(db, settings, parsed.data.token), { status: 201 });
	} catch (error) {
		return errorResponse(error);
	}
};
