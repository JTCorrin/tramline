import { CreateOidcTrust } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { oidc } from '#lib/server/domain/index.js';

/** Repositories whose GitHub Actions may deploy; managed by people, never tokens. */
export const GET = endpoint((ctx) => oidc.listTrust(ctx), { session: true });

export const POST = endpoint(
	async (ctx, event) => oidc.createTrust(ctx, await body(event, CreateOidcTrust)),
	{ session: true }
);
