import { endpoint } from '#lib/server/api/handler.js';
import { publicAccess } from '#lib/server/domain/index.js';

// a POST: it reveals the tunnel token
export const POST = endpoint((ctx) => publicAccess.connector(ctx), { session: true });
