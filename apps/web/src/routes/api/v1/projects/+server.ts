import { CreateProject } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { projects } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx) => projects.list(ctx));

export const POST = endpoint(async (ctx, event) =>
	projects.create(ctx, await body(event, CreateProject))
);
