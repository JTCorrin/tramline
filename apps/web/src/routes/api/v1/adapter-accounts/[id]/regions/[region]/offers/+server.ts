import { endpoint } from '#lib/server/api/handler.js';
import { adapters } from '#lib/server/domain/index.js';

/** Machine sizes in a region, with their prices and GPUs. */
export const GET = endpoint((ctx, { params }) => adapters.offers(ctx, params.id!, params.region!), {
	session: true
});
