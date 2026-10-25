import { CreateApiToken } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { tokens } from '#lib/server/domain/index.js';

/** Tokens are managed by people, never by other tokens. */
export const GET = endpoint((ctx) => tokens.list(ctx), { session: true });

/** Creates a token; its secret is in this response and nowhere else. */
export const POST = endpoint(
	async (ctx, event) => tokens.create(ctx, await body(event, CreateApiToken)),
	{ session: true }
);
