import { UpdateNode } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { nodes } from '#lib/server/domain/index.js';

export const PATCH = endpoint(
	async (ctx, event) => nodes.update(ctx, event.params.id!, await body(event, UpdateNode)),
	{ session: true }
);

export const DELETE = endpoint((ctx, { params }) => nodes.remove(ctx, params.id!), {
	session: true
});
