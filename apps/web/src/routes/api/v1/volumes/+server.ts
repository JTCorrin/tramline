import { endpoint, param } from '#lib/server/api/handler.js';
import { backups } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx, event) =>
	backups.listVolumes(ctx, param(event, 'serviceId'), param(event, 'environmentId'))
);
