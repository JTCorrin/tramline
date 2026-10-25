import { endpoint } from '#lib/server/api/handler.js';
import { tokens } from '#lib/server/domain/index.js';

export const DELETE = endpoint((ctx, { params }) => tokens.revoke(ctx, params.id!), {
	session: true
});
