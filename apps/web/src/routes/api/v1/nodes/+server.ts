import { CreateJoinToken } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { nodes } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx) => nodes.list(ctx));

/** A one-time join token and the command that enrolls a machine with it. */
export const POST = endpoint(
	async (ctx, event) =>
		nodes.createJoinToken(ctx, await body(event, CreateJoinToken), event.url.origin),
	{ session: true }
);
