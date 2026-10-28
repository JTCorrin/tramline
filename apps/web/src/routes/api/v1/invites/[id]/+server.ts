import { endpoint } from '#lib/server/api/handler.js';
import { invites } from '#lib/server/domain/index.js';

export const DELETE = endpoint((ctx, { params }) => invites.revoke(ctx, params.id!), {
	session: true
});
