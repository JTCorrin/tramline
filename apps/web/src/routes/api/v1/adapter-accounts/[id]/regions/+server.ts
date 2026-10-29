import { endpoint } from '#lib/server/api/handler.js';
import { adapters } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx, { params }) => adapters.regions(ctx, params.id!), {
	session: true
});
