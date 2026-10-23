import { AgentHello } from '@tramline/contracts';
import { agentEndpoint } from '#lib/server/api/agent.js';
import { body } from '#lib/server/api/handler.js';
import { db } from '#lib/server/db/index.js';
import { recordHello } from '#lib/server/nodes/registry.js';

export const POST = agentEndpoint(async (node, event) => {
	recordHello(db, node.id, await body(event, AgentHello));
	return { nodeId: node.id, name: node.name };
});
