import { ListCloudflareZones } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { publicAccess } from '#lib/server/domain/index.js';

// a POST, so the API token travels in the body rather than the URL
export const POST = endpoint(
	async (ctx, event) => publicAccess.zones(ctx, await body(event, ListCloudflareZones)),
	{ session: true }
);
