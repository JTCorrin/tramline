import { AddCustomDomain } from '@tramline/contracts';
import { body, endpoint, param } from '#lib/server/api/handler.js';
import { domains } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx, event) =>
	domains.list(ctx, param(event, 'serviceId'), param(event, 'environmentId'))
);

/** Adds a domain; traffic is routed once its TXT record proves ownership. */
export const POST = endpoint(async (ctx, event) =>
	domains.add(ctx, await body(event, AddCustomDomain))
);
