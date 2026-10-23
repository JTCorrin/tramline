import { LogBatch } from '@tramline/contracts';
import { inArray } from 'drizzle-orm';
import { agentEndpoint } from '#lib/server/api/agent.js';
import { body, secrets } from '#lib/server/api/handler.js';
import { db, schema } from '#lib/server/db/index.js';
import { appendLogs } from '#lib/server/nodes/logs.js';
import { redactorFor } from '#lib/server/nodes/redact.js';
import { settings } from '#lib/server/settings.server.js';

export const POST = agentEndpoint(async (node, event) => {
	const { lines } = await body(event, LogBatch);
	// agents may only write logs for deployments scheduled on them
	const ids = [...new Set(lines.map((l) => l.deploymentId))];
	const owned = new Set(
		db
			.select({ id: schema.deployment.id, nodeId: schema.deployment.nodeId })
			.from(schema.deployment)
			.where(inArray(schema.deployment.id, ids))
			.all()
			.filter((d) => d.nodeId === node.id)
			.map((d) => d.id)
	);
	appendLogs(
		settings.dataDir,
		lines
			.filter((l) => owned.has(l.deploymentId) && l.stream !== 'system')
			// secrets never reach disk or the browser, even if an app prints them
			.map((l) => ({ ...l, line: redactorFor(db, secrets, l.deploymentId)(l.line) }))
	);
});
