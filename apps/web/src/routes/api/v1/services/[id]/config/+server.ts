import { ServiceConfigPatch } from '@tramline/contracts';
import { body, endpoint, param } from '#lib/server/api/handler.js';
import { services } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx, event) =>
	services.getConfig(ctx, event.params.id!, param(event, 'environmentId'))
);

/** Stages a config change for the environment; deploy applies it. */
export const PATCH = endpoint(async (ctx, event) =>
	services.stageConfig(
		ctx,
		event.params.id!,
		param(event, 'environmentId'),
		await body(event, ServiceConfigPatch)
	)
);
