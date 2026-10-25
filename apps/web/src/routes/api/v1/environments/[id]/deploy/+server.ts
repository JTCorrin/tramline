import { endpoint } from '#lib/server/api/handler.js';
import { changes } from '#lib/server/domain/index.js';

/** Applies staged changes and queues deployments. Returns the queued deployments. */
export const POST = endpoint((ctx, { params }) => changes.deploy(ctx, params.id!), {
	scope: 'deploy'
});
