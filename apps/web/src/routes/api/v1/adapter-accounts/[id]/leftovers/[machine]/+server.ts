import { endpoint } from '#lib/server/api/handler.js';
import { adapters } from '#lib/server/domain/index.js';

export const DELETE = endpoint(
	(ctx, { params }) => adapters.destroyLeftover(ctx, params.id!, params.machine!),
	{ session: true }
);
