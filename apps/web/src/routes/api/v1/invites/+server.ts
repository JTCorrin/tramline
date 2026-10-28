import { z } from 'zod';
import { body, endpoint } from '#lib/server/api/handler.js';
import { invites } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx) => invites.list(ctx), { session: true });

/** A one-time invite link; the response holds the only copy. */
export const POST = endpoint(
	async (ctx, event) =>
		invites.create(
			ctx,
			await body(event, z.object({ role: z.enum(['member', 'admin']).default('member') })),
			event.url.origin
		),
	{ session: true }
);
