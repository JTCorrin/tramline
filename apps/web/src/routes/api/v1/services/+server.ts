import { CreateService } from '@tramline/contracts';
import { body, endpoint, param } from '#lib/server/api/handler.js';
import { services } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx, event) => services.list(ctx, param(event, 'projectId')));

export const POST = endpoint(async (ctx, event) =>
	services.create(ctx, await body(event, CreateService))
);
