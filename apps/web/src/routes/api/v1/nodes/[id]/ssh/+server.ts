import { endpoint } from '#lib/server/api/handler.js';
import { traffic } from '#lib/server/domain/index.js';

/** Failed SSH logins on the node over the last day; install admins only. */
export const GET = endpoint((ctx, event) => traffic.nodeSshFailures(ctx, event.params.id!));
