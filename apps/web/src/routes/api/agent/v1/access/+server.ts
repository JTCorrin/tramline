import { AccessBatch } from '@tramline/contracts';
import { agentEndpoint } from '#lib/server/api/agent.js';
import { body } from '#lib/server/api/handler.js';
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/settings.server.js';
import { DEFAULT_TRAFFIC } from '#lib/server/settings.js';
import { asnData } from '#lib/server/traffic/asn.server.js';
import { recordAccess } from '#lib/server/traffic/store.js';

/** What came in through the node's ingress and TCP proxies. */
export const POST = agentEndpoint(async (node, event) => {
	const { entries } = await body(event, AccessBatch);
	recordAccess(db, node.id, entries, {
		settings: settings.traffic ?? DEFAULT_TRAFFIC,
		lookup: (address) => asnData.lookup(address)
	});
});
