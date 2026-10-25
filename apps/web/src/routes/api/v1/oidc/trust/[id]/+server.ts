import { endpoint } from '#lib/server/api/handler.js';
import { oidc } from '#lib/server/domain/index.js';

export const DELETE = endpoint((ctx, { params }) => oidc.removeTrust(ctx, params.id!), {
	session: true
});
