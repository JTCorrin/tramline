import { ProvisionNode } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { adapters } from '#lib/server/domain/index.js';

/** Has an account's adapter create a machine, which enrolls itself as a node. */
export const POST = endpoint(
	async (ctx, event) => adapters.provision(ctx, await body(event, ProvisionNode), event.url.origin),
	{ session: true }
);
