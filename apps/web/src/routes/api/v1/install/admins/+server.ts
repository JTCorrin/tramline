import { z } from 'zod';
import { body, endpoint } from '#lib/server/api/handler.js';
import { admins } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx) => admins.list(ctx), { session: true });

/** Makes someone who already has an account an install admin. */
export const POST = endpoint(
	async (ctx, event) =>
		admins.grant(ctx, (await body(event, z.object({ email: z.email() }))).email),
	{ session: true }
);
