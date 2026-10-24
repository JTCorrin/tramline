import { endpoint } from '#lib/server/api/handler.js';
import { domains } from '#lib/server/domain/index.js';

export const DELETE = endpoint((ctx, { params }) => domains.remove(ctx, params.id!));
