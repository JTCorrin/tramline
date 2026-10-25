import { endpoint, param } from '#lib/server/api/handler.js';
import { data } from '#lib/server/domain/index.js';

/** A page of a table's rows, read-only. */
export const GET = endpoint((ctx, event) =>
	data.rows(ctx, {
		serviceId: param(event, 'serviceId'),
		environmentId: param(event, 'environmentId'),
		schema: param(event, 'schema'),
		table: param(event, 'table'),
		offset: Number(event.url.searchParams.get('offset') ?? 0)
	})
);
