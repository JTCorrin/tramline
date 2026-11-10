import { PlacementRequest } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { placement } from '#lib/server/prices/catalog.js';

/** Where a workload could run: nodes with room, then machine sizes from every account, cheapest first. */
export const POST = endpoint(
	async (ctx, event) => placement(ctx, await body(event, PlacementRequest)),
	{
		session: true
	}
);
