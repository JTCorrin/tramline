import { UpdateService } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { services } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx, { params }) => services.get(ctx, params.id!));

export const PATCH = endpoint(async (ctx, event) =>
	services.update(ctx, event.params.id!, await body(event, UpdateService))
);

export const DELETE = endpoint((ctx, { params }) => services.remove(ctx, params.id!));
