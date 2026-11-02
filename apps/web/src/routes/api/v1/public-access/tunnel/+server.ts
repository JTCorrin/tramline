import { CreatePublicTunnel, UpdatePublicTunnel } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { publicAccess } from '#lib/server/domain/index.js';

export const POST = endpoint(
	async (ctx, event) => publicAccess.create(ctx, await body(event, CreatePublicTunnel)),
	{ session: true }
);

export const PATCH = endpoint(
	async (ctx, event) => publicAccess.update(ctx, await body(event, UpdatePublicTunnel)),
	{ session: true }
);

export const DELETE = endpoint(
	(ctx, { url }) => publicAccess.remove(ctx, { force: url.searchParams.get('force') === 'true' }),
	{ session: true }
);
