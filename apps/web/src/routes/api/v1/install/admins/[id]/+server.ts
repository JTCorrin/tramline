import { endpoint } from '#lib/server/api/handler.js';
import { admins } from '#lib/server/domain/index.js';

export const DELETE = endpoint((ctx, { params }) => admins.revoke(ctx, params.id!), {
	session: true
});
