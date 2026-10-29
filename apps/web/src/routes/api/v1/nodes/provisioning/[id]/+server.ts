import { endpoint } from '#lib/server/api/handler.js';
import { adapters } from '#lib/server/domain/index.js';

/** Destroys a machine that hasn't enrolled, and its join token. */
export const DELETE = endpoint((ctx, { params }) => adapters.cancelProvisioning(ctx, params.id!), {
	session: true
});
