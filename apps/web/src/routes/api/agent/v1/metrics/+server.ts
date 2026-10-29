import { MetricsBatch } from '@tramline/contracts';
import { agentEndpoint } from '#lib/server/api/agent.js';
import { body } from '#lib/server/api/handler.js';
import { db } from '#lib/server/db/index.js';
import { recordMetrics } from '#lib/server/metrics/store.js';

export const POST = agentEndpoint(async (node, event) => {
	recordMetrics(db, node.id, await body(event, MetricsBatch));
});
