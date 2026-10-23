import { endpoint, param } from '#lib/server/api/handler.js';
import { deployments } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx, event) =>
	deployments.list(ctx, {
		serviceId: param(event, 'serviceId'),
		environmentId: param(event, 'environmentId')
	})
);
