import { endpoint } from '#lib/server/api/handler.js';
import { changes } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx, { params }) => changes.summary(ctx, params.id!));

/** Discards every staged change in the environment. */
/** Discarding staged changes only touches drafts, so staging tokens may do it. */
export const DELETE = endpoint((ctx, { params }) => changes.discard(ctx, params.id!), {
	scope: 'write'
});
