import { CreateEnvironment } from '@tramline/contracts';
import { body, endpoint, param } from '#lib/server/api/handler.js';
import { environments } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx, event) => environments.list(ctx, param(event, 'projectId')));

export const POST = endpoint(async (ctx, event) =>
	environments.create(ctx, await body(event, CreateEnvironment))
);
