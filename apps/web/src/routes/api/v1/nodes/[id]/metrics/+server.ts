import { endpoint } from '#lib/server/api/handler.js';
import { metrics } from '#lib/server/domain/index.js';

/** `?range=1h|6h|24h|7d|30d` */
export const GET = endpoint((ctx, event) =>
	metrics.nodeMetrics(ctx, event.params.id!, event.url.searchParams.get('range'))
);
