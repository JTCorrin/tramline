import { endpoint, param } from '#lib/server/api/handler.js';
import { metrics } from '#lib/server/domain/index.js';

/** `?environmentId=…&range=1h|6h|24h|7d|30d` */
export const GET = endpoint((ctx, event) =>
	metrics.serviceMetrics(
		ctx,
		event.params.id!,
		param(event, 'environmentId'),
		event.url.searchParams.get('range')
	)
);
