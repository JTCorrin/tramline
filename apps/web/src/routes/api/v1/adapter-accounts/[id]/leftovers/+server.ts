import { endpoint } from '#lib/server/api/handler.js';
import { adapters } from '#lib/server/domain/index.js';

/** Machines with Tramline's tag that no node accounts for. */
export const GET = endpoint((ctx, { params }) => adapters.leftovers(ctx, params.id!), {
	session: true
});
