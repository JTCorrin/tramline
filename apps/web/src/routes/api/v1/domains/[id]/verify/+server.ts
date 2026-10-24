import { endpoint } from '#lib/server/api/handler.js';
import { domains } from '#lib/server/domain/index.js';

/** Looks for the domain's TXT record now. */
export const POST = endpoint((ctx, { params }) => domains.verify(ctx, params.id!));
