import { endpoint, param } from '#lib/server/api/handler.js';
import { data } from '#lib/server/domain/index.js';

/** Tables of a Postgres service, read-only. */
export const GET = endpoint((ctx, event) =>
	data.tables(ctx, param(event, 'serviceId'), param(event, 'environmentId'))
);
