import { StageVariables } from '@tramline/contracts';
import { body, endpoint, param } from '#lib/server/api/handler.js';
import { variables } from '#lib/server/domain/index.js';

/** `?environmentId=` plus `serviceId=`, or no serviceId for shared variables. */
export const GET = endpoint((ctx, event) =>
	variables.list(ctx, {
		environmentId: param(event, 'environmentId'),
		serviceId: event.url.searchParams.get('serviceId')
	})
);

/** Stages variable edits. */
export const PATCH = endpoint(async (ctx, event) =>
	variables.stage(ctx, await body(event, StageVariables))
);
