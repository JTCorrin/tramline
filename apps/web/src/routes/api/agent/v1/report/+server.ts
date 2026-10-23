import { AgentReport } from '@tramline/contracts';
import { agentEndpoint } from '#lib/server/api/agent.js';
import { body } from '#lib/server/api/handler.js';
import { db } from '#lib/server/db/index.js';
import { reconcile } from '#lib/server/nodes/reconciler.js';
import { recordReport } from '#lib/server/nodes/registry.js';
import { settings } from '#lib/server/settings.server.js';

export const POST = agentEndpoint(async (node, event) => {
	recordReport(db, node.id, await body(event, AgentReport));
	reconcile(db, settings);
});
