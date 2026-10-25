import { endpoint } from '#lib/server/api/handler.js';
import { nodes } from '#lib/server/domain/index.js';

/** Cordons the node and moves its stateless deployments to others. */
export const POST = endpoint((ctx, { params }) => nodes.drain(ctx, params.id!), { session: true });
