import { UpdateEnvironment } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { environments } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx, { params }) => environments.get(ctx, params.id!));

export const PATCH = endpoint(async (ctx, event) =>
	environments.update(ctx, event.params.id!, await body(event, UpdateEnvironment))
);

export const DELETE = endpoint((ctx, { params }) => environments.remove(ctx, params.id!));
