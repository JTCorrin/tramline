import { QueryResult } from '@tramline/contracts';
import { agentEndpoint } from '#lib/server/api/agent.js';
import { answer } from '#lib/server/nodes/queries.js';

/** A node's answer to a data browser query. */
export const POST = agentEndpoint(async (node, event) => {
	answer(node.id, event.params.id!, QueryResult.parse(await event.request.json()));
});
