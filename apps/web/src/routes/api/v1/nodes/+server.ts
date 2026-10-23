import { endpoint } from '#lib/server/api/handler.js';
import { nodes } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx) => nodes.list(ctx));
