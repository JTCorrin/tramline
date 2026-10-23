import { endpoint } from '#lib/server/api/handler.js';
import { changes } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx, { params }) => changes.summary(ctx, params.id!));

/** Discards every staged change in the environment. */
export const DELETE = endpoint((ctx, { params }) => changes.discard(ctx, params.id!));
