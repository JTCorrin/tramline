import { endpoint } from '#lib/server/api/handler.js';
import { adapters } from '#lib/server/domain/index.js';

/** "Test connection": the adapter checks the saved credentials with the provider. */
export const POST = endpoint((ctx, { params }) => adapters.testAccount(ctx, params.id!), {
	session: true
});
