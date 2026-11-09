import { endpoint } from '#lib/server/api/handler.js';
import { traffic } from '#lib/server/domain/index.js';
import { asnData } from '#lib/server/traffic/asn.server.js';

/** `?environmentId=…&range=24h&status=4xx&client=…&asn=…&path=…`: owners and admins only. */
export const GET = endpoint((ctx, event) =>
	traffic.serviceTraffic(ctx, event.params.id!, Object.fromEntries(event.url.searchParams), {
		networks: asnData.table !== null
	})
);
