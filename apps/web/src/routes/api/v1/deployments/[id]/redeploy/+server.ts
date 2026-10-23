import { endpoint } from '#lib/server/api/handler.js';
import { deployments } from '#lib/server/domain/index.js';

/** Queues a copy of this deployment: a restart for the latest, a rollback for older ones. */
export const POST = endpoint((ctx, { params }) => deployments.redeploy(ctx, params.id!));
