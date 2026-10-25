import { endpoint } from '#lib/server/api/handler.js';
import { deployments } from '#lib/server/domain/index.js';

/** Stops the deployment's containers. */
export const POST = endpoint((ctx, { params }) => deployments.remove(ctx, params.id!), {
	scope: 'deploy'
});
