import { errorResponse, secrets } from '#lib/server/api/handler.js';
import { AppError } from '#lib/server/api/errors.js';
import { db, schema } from '#lib/server/db/index.js';
import { verifySignature } from '#lib/server/github/api.js';
import { loadApp } from '#lib/server/github/app.js';
import { handlePush, type PushPayload } from '#lib/server/github/push.js';
import { settings } from '#lib/server/settings.server.js';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** GitHub App webhooks. Every delivery must carry a valid HMAC signature. */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.text();
		const app = loadApp(db, secrets);
		if (
			!app ||
			!verifySignature(app.webhookSecret, body, request.headers.get('x-hub-signature-256'))
		) {
			throw new AppError('unauthenticated', 'Invalid webhook signature');
		}
		const payload = JSON.parse(body);
		switch (request.headers.get('x-github-event')) {
			case 'push':
				return Response.json(
					{ deployments: handlePush(db, secrets, settings, payload as PushPayload) },
					{ status: 202 }
				);
			case 'installation':
				if (payload.action === 'deleted') {
					db.delete(schema.githubInstallation)
						.where(eq(schema.githubInstallation.id, String(payload.installation.id)))
						.run();
				}
				return new Response(null, { status: 204 });
			default:
				return new Response(null, { status: 204 });
		}
	} catch (error) {
		return errorResponse(error);
	}
};
