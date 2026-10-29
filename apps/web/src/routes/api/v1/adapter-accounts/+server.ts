import { CreateAdapterAccount } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { adapters } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx) => adapters.listAccounts(ctx), { session: true });

export const POST = endpoint(
	async (ctx, event) => adapters.createAccount(ctx, await body(event, CreateAdapterAccount)),
	{ session: true }
);
