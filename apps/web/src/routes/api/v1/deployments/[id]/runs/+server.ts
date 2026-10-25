import { endpoint } from '#lib/server/api/handler.js';
import { deployments } from '#lib/server/domain/index.js';

/** A cron service's recent runs. */
export const GET = endpoint((ctx, { params }) => deployments.runs(ctx, params.id!));

/** Runs a cron service's job now. */
export const POST = endpoint((ctx, { params }) => deployments.runNow(ctx, params.id!), {
	scope: 'deploy'
});
