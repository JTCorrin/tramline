import { UpdateProject } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { projects } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx, { params }) => projects.get(ctx, params.id!));

export const PATCH = endpoint(async (ctx, event) =>
	projects.update(ctx, event.params.id!, await body(event, UpdateProject))
);

export const DELETE = endpoint((ctx, { params }) => projects.remove(ctx, params.id!));
