import { sql } from 'drizzle-orm';
import { deployment } from '../db/schema';

type Placed = { nodeId: string | null; replicaNodes?: string[] | null };

/** The node one replica runs on. */
export const replicaNode = (dep: Placed, replica: number) =>
	dep.replicaNodes?.[replica] ?? dep.nodeId;

/** Every node a deployment has replicas on: just its own unless they are spread. */
export function nodesOf(dep: Placed): string[] {
	if (dep.replicaNodes?.length) return [...new Set(dep.replicaNodes)];
	return dep.nodeId ? [dep.nodeId] : [];
}

/** How many of a deployment's replicas run on a node. */
export function replicasOn(
	dep: Placed & { config: { deploy: { replicas: number; cronSchedule?: string | null } } },
	nodeId: string
) {
	if (dep.replicaNodes?.length) return dep.replicaNodes.filter((n) => n === nodeId).length;
	if (dep.nodeId !== nodeId) return 0;
	// a cron service runs one container at a time
	return dep.config.deploy.cronSchedule ? 1 : dep.config.deploy.replicas;
}

/** SQL: the deployment is built on, or has a replica on, this node. */
export const onNode = (nodeId: string) =>
	sql`(${deployment.nodeId} = ${nodeId} or exists (select 1 from json_each(${deployment.replicaNodes}) where value = ${nodeId}))`;

/** What one replica reserves on its node: its requests, or else its memory limit. */
export function replicaRequest(config: {
	deploy: { memoryMb?: number | null; memoryRequestMb?: number | null; cpuRequest?: number | null };
}) {
	return {
		memoryMb: config.deploy.memoryRequestMb ?? config.deploy.memoryMb ?? 0,
		cpus: config.deploy.cpuRequest ?? 0
	};
}

/** What a deployment reserves on one node, over the replicas it runs there. */
export function reservedOn(
	dep: Placed & {
		config: Parameters<typeof replicaRequest>[0] & Parameters<typeof replicasOn>[0]['config'];
	},
	nodeId: string
) {
	const count = replicasOn(dep, nodeId);
	const one = replicaRequest(dep.config);
	return { memoryMb: one.memoryMb * count, cpus: one.cpus * count };
}
