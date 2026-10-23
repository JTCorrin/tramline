import { endpoint } from '#lib/server/api/handler.js';
import { canvas } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx, { params }) => canvas.get(ctx, params.id!));
