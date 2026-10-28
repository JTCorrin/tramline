import { endpoint } from '#lib/server/api/handler.js';
import { adapters } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx) => adapters.provisioning(ctx), { session: true });
