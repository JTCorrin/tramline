import { LogBatch } from '@tramline/contracts';
import { inArray } from 'drizzle-orm';
import { agentEndpoint } from '#lib/server/api/agent.js';
import { body, secrets } from '#lib/server/api/handler.js';
import { db, schema } from '#lib/server/db/index.js';
import { appendLogs } from '#lib/server/nodes/logs.js';
import { nodesOf } from '#lib/server/nodes/placement.js';
import { redactorFor } from '#lib/server/nodes/redact.js';
import { settings } from '#lib/server/settings.server.js';

export const POST = agentEndpoint(async (node, event) => {
	const { lines } = await body(event, LogBatch);
	// agents may only write logs for deployments with a replica (or a build) on them
	const ids = [...new Set(lines.map((l) => l.deploymentId))];
	const owned = new Set(
		db
			.select({
				id: schema.deployment.id,
				nodeId: schema.deployment.nodeId,
				replicaNodes: schema.deployment.replicaNodes
			})
			.from(schema.deployment)
			.where(inArray(schema.deployment.id, ids))
			.all()
			.filter((d) => d.nodeId === node.id || nodesOf(d).includes(node.id))
			.map((d) => d.id)
	);
	appendLogs(
		settings.dataDir,
		lines
			.filter((l) => owned.has(l.deploymentId) && l.stream !== 'system')
			// known secret values are masked before they reach disk or the browser; this stops
			// accidental disclosure, not code that deliberately encodes a secret it was given
			.map((l) => ({ ...l, line: redactorFor(db, secrets, l.deploymentId)(l.line) }))
	);
});
