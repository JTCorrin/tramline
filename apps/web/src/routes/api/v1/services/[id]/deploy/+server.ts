import { z } from 'zod';
import { body, endpoint } from '#lib/server/api/handler.js';
import { deployments } from '#lib/server/domain/index.js';

const DeployService = z.object({
	environmentId: z.string(),
	/** For repository services: the exact commit to build, e.g. the one CI just tested. */
	commit: z
		.string()
		.regex(/^[0-9a-f]{7,40}$/, 'Use a commit SHA')
		.nullable()
		.optional()
});

/** Deploys the service as deployed now, optionally at a commit. For CI. */
export const POST = endpoint(
	async (ctx, event) =>
		deployments.deployService(ctx, {
			serviceId: event.params.id!,
			...(await body(event, DeployService))
		}),
	{ scope: 'deploy' }
);
