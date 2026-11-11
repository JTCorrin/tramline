import { endpoint } from '#lib/server/api/handler.js';
import { projectCosts } from '#lib/server/prices/costs.js';

/** What the project costs a month, environment by environment. */
export const GET = endpoint((ctx, { params }) => projectCosts(ctx, params.id!));
