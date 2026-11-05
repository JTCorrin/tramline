import { endpoint } from '#lib/server/api/handler.js';
import { nodes } from '#lib/server/domain/index.js';

/** Asks the node's agent to update itself to the latest image. */
export const POST = endpoint((ctx, { params }) => nodes.updateAgent(ctx, params.id!), {
	session: true
});
