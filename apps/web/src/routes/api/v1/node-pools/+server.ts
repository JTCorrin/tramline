import { CreateNodePool } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { pools } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx) => pools.list(ctx), { session: true });

/** A pool of machines Tramline adds and removes by itself. */
export const POST = endpoint(
	async (ctx, event) => pools.create(ctx, await body(event, CreateNodePool), event.url.origin),
	{ session: true }
);
