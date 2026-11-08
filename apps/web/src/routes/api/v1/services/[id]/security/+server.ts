import { endpoint, param } from '#lib/server/api/handler.js';
import { metrics } from '#lib/server/domain/index.js';

/** `?environmentId=…`: what the service's containers tried that containment blocked, last 7 days. */
export const GET = endpoint((ctx, event) =>
	metrics.securityEvents(ctx, event.params.id!, param(event, 'environmentId'))
);
