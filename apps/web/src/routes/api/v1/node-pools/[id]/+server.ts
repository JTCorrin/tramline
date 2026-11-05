import { UpdateNodePool } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { pools } from '#lib/server/domain/index.js';

export const PATCH = endpoint(
	async (ctx, event) => pools.update(ctx, event.params.id!, await body(event, UpdateNodePool)),
	{ session: true }
);

/** Drains and destroys the pool's machines; the pool goes once they have. */
export const DELETE = endpoint(
	async (ctx, { params }) => (await pools.remove(ctx, params.id!)) ?? undefined,
	{ session: true }
);
