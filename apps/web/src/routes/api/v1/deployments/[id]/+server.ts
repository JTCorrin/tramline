import { endpoint } from '#lib/server/api/handler.js';
import { deployments } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx, { params }) => deployments.get(ctx, params.id!));
