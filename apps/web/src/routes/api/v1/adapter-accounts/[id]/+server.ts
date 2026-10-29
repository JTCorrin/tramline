import { UpdateAdapterAccount } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { adapters } from '#lib/server/domain/index.js';

export const PATCH = endpoint(
	async (ctx, event) =>
		adapters.updateAccount(ctx, event.params.id!, await body(event, UpdateAdapterAccount)),
	{ session: true }
);

export const DELETE = endpoint((ctx, { params }) => adapters.removeAccount(ctx, params.id!), {
	session: true
});
