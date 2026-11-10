import { endpoint } from '#lib/server/api/handler.js';
import { environmentCosts } from '#lib/server/prices/costs.js';

/** What the environment's running services cost a month, from their share of their nodes. */
export const GET = endpoint((ctx, { params }) => environmentCosts(ctx, params.id!));
