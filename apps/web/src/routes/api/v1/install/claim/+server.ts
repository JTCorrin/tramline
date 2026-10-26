import { z } from 'zod';
import { body, endpoint } from '#lib/server/api/handler.js';
import { admins } from '#lib/server/domain/index.js';

/** The first admin claims the install with the setup token from the server's data directory. */
export const POST = endpoint(
	async (ctx, event) => {
		const { token } = await body(event, z.object({ token: z.string().min(1).max(200) }));
		admins.claim(ctx, token);
	},
	{ session: true }
);
