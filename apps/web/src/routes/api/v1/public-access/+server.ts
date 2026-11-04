import { endpoint } from '#lib/server/api/handler.js';
import { publicAccess } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx) => publicAccess.get(ctx), { session: true });
