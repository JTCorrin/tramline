import type {
	MetricRange,
	MetricsBatch,
	NodeMetricPoint,
	NodeMetrics,
	ServiceMetricPoint,
	ServiceMetrics
} from '@tramline/contracts';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { containerMetric, deployment, nodeMetric } from '../db/schema';

export const MINUTE = 60;
export const HOUR = 3600;
/** How long each resolution is kept. */
export const KEEP_MS = { [MINUTE]: 48 * 3600_000, [HOUR]: 30 * 86_400_000 };

const RANGE_MS: Record<MetricRange, number> = {
	'1h': 3600_000,
	'6h': 6 * 3600_000,
	'24h': 24 * 3600_000,
	'7d': 7 * 86_400_000,
	'30d': 30 * 86_400_000
};

const bucketOf = (at: number, step: number) => Math.floor(at / (step * 1000)) * step * 1000;

/**
 * Folds an agent's samples into this minute's buckets. Buckets follow the
 * control plane's clock, not the agent's, so a node with a skewed clock still
 * lines up. A node only records metrics for deployments placed on it.
 */
export function recordMetrics(db: DbOrTx, nodeId: string, batch: MetricsBatch, now = Date.now()) {
	const bucket = bucketOf(now, MINUTE);
	if (batch.node) {
		const s = batch.node;
		db.insert(nodeMetric)
			.values({
				step: MINUTE,
				bucket,
				nodeId,
				samples: 1,
				cpuSum: s.cpuPercent,
				cpuMax: s.cpuPercent,
				memoryUsedSum: s.memoryUsedMb,
				memoryUsedMax: s.memoryUsedMb,
				memoryTotal: s.memoryTotalMb,
				diskUsed: s.diskUsedMb,
				diskTotal: s.diskTotalMb
			})
			.onConflictDoUpdate({
				target: [nodeMetric.step, nodeMetric.nodeId, nodeMetric.bucket],
				set: {
					samples: sql`${nodeMetric.samples} + 1`,
					cpuSum: sql`${nodeMetric.cpuSum} + excluded.cpu_sum`,
					cpuMax: sql`max(${nodeMetric.cpuMax}, excluded.cpu_max)`,
					memoryUsedSum: sql`${nodeMetric.memoryUsedSum} + excluded.memory_used_sum`,
					memoryUsedMax: sql`max(${nodeMetric.memoryUsedMax}, excluded.memory_used_max)`,
					memoryTotal: sql`excluded.memory_total`,
					diskUsed: sql`coalesce(excluded.disk_used, ${nodeMetric.diskUsed})`,
					diskTotal: sql`coalesce(excluded.disk_total, ${nodeMetric.diskTotal})`
				}
			})
			.run();
	}

	const ids = [...new Set(batch.containers.map((c) => c.deploymentId))];
	if (!ids.length) return;
	const placed = new Map(
		db
			.select({
				id: deployment.id,
				nodeId: deployment.nodeId,
				serviceId: deployment.serviceId,
				environmentId: deployment.environmentId,
				config: deployment.config,
				status: deployment.status
			})
			.from(deployment)
			.where(inArray(deployment.id, ids))
			.all()
			.filter((d) => d.nodeId === nodeId)
			.map((d) => [d.id, d])
	);
	for (const s of batch.containers) {
		const owner = placed.get(s.deploymentId);
		if (!owner || !['deploying', 'active', 'crashed'].includes(owner.status)) continue;
		// The agent may only create series for replicas the control plane assigned.
		const replicas = owner.config.deploy.cronSchedule ? 1 : owner.config.deploy.replicas;
		if (!Number.isInteger(s.replica) || s.replica < 0 || s.replica >= replicas) continue;
		db.insert(containerMetric)
			.values({
				step: MINUTE,
				bucket,
				deploymentId: s.deploymentId,
				replica: s.replica,
				serviceId: owner.serviceId,
				environmentId: owner.environmentId,
				samples: 1,
				cpuSum: s.cpuPercent,
				cpuMax: s.cpuPercent,
				memorySum: s.memoryMb,
				memoryMax: s.memoryMb,
				memoryLimit: s.memoryLimitMb,
				rxBytes: s.rxBytes,
				txBytes: s.txBytes
			})
			.onConflictDoUpdate({
				target: [
					containerMetric.step,
					containerMetric.deploymentId,
					containerMetric.replica,
					containerMetric.bucket
				],
				set: {
					samples: sql`${containerMetric.samples} + 1`,
					cpuSum: sql`${containerMetric.cpuSum} + excluded.cpu_sum`,
					cpuMax: sql`max(${containerMetric.cpuMax}, excluded.cpu_max)`,
					memorySum: sql`${containerMetric.memorySum} + excluded.memory_sum`,
					memoryMax: sql`max(${containerMetric.memoryMax}, excluded.memory_max)`,
					memoryLimit: sql`excluded.memory_limit`,
					rxBytes: sql`${containerMetric.rxBytes} + excluded.rx_bytes`,
					txBytes: sql`${containerMetric.txBytes} + excluded.tx_bytes`
				}
			})
			.run();
	}
}

/**
 * Rolls minutes up into hours, resuming each series at its last saved hour.
 * The last two hours are recomputed, so an hour still filling stays current.
 */
export function rollUp(db: DbOrTx, now = Date.now()) {
	const from = bucketOf(now, HOUR) - HOUR * 1000;
	// Never replace an older complete hour with a partially pruned minute window.
	const retainedFrom = Math.ceil((now - KEEP_MS[MINUTE]) / (HOUR * 1000)) * HOUR * 1000;
	// bound numbers are floats to SQLite, so the division is cast back to a whole hour
	const hour = sql`cast(bucket / ${HOUR * 1000} as integer) * ${HOUR * 1000}`;
	db.run(sql`
		insert into node_metric (step, bucket, node_id, samples, cpu_sum, cpu_max, memory_used_sum,
			memory_used_max, memory_total, disk_used, disk_total)
		select ${HOUR}, ${hour}, node_id, sum(samples), sum(cpu_sum), max(cpu_max), sum(memory_used_sum),
			max(memory_used_max), max(memory_total), max(disk_used), max(disk_total)
		from node_metric where step = ${MINUTE} and bucket >= ${retainedFrom}
			and (bucket >= ${from} or bucket >= coalesce((select max(h.bucket) from node_metric h
				where h.step = ${HOUR} and h.node_id = node_metric.node_id), ${retainedFrom}))
		group by node_id, ${hour}
		on conflict (step, node_id, bucket) do update set samples = excluded.samples,
			cpu_sum = excluded.cpu_sum, cpu_max = excluded.cpu_max,
			memory_used_sum = excluded.memory_used_sum, memory_used_max = excluded.memory_used_max,
			memory_total = excluded.memory_total, disk_used = excluded.disk_used,
			disk_total = excluded.disk_total`);
	db.run(sql`
		insert into container_metric (step, bucket, deployment_id, replica, service_id, environment_id,
			samples, cpu_sum, cpu_max, memory_sum, memory_max, memory_limit, rx_bytes, tx_bytes)
		select ${HOUR}, ${hour}, deployment_id, replica, max(service_id), max(environment_id),
			sum(samples), sum(cpu_sum), max(cpu_max), sum(memory_sum), max(memory_max),
			max(memory_limit), sum(rx_bytes), sum(tx_bytes)
		from container_metric where step = ${MINUTE} and bucket >= ${retainedFrom}
			and (bucket >= ${from} or bucket >= coalesce((select max(h.bucket) from container_metric h
				where h.step = ${HOUR} and h.deployment_id = container_metric.deployment_id
				and h.replica = container_metric.replica), ${retainedFrom}))
		group by deployment_id, replica, ${hour}
		on conflict (step, deployment_id, replica, bucket) do update set samples = excluded.samples,
			cpu_sum = excluded.cpu_sum, cpu_max = excluded.cpu_max, memory_sum = excluded.memory_sum,
			memory_max = excluded.memory_max, memory_limit = excluded.memory_limit,
			rx_bytes = excluded.rx_bytes, tx_bytes = excluded.tx_bytes`);
}

export function pruneMetrics(db: DbOrTx, now = Date.now()) {
	for (const step of [MINUTE, HOUR] as const) {
		const before = now - KEEP_MS[step];
		db.delete(nodeMetric)
			.where(and(eq(nodeMetric.step, step), lt(nodeMetric.bucket, before)))
			.run();
		db.delete(containerMetric)
			.where(and(eq(containerMetric.step, step), lt(containerMetric.bucket, before)))
			.run();
	}
}

const window = (range: MetricRange, now: number) => {
	const step = RANGE_MS[range] <= RANGE_MS['24h'] ? MINUTE : HOUR;
	return { step, from: bucketOf(now - RANGE_MS[range], step) };
};

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * A service's metrics in an environment, summed over its replicas (and, during
 * a deploy, over the old and new deployment while both run).
 */
export function serviceMetrics(
	db: DbOrTx,
	serviceId: string,
	environmentId: string,
	range: MetricRange,
	now = Date.now()
): ServiceMetrics {
	const { step, from } = window(range, now);
	const m = containerMetric;
	const rows = db
		.select({
			bucket: m.bucket,
			cpu: sql<number>`sum(${m.cpuSum} / ${m.samples})`,
			cpuMax: sql<number>`sum(${m.cpuMax})`,
			memory: sql<number>`sum(${m.memorySum} / ${m.samples})`,
			memoryMax: sql<number>`sum(${m.memoryMax})`,
			// a limit only counts when every replica has one
			limit: sql<
				number | null
			>`case when count(${m.memoryLimit}) = count(*) then sum(${m.memoryLimit}) end`,
			rx: sql<number>`sum(${m.rxBytes})`,
			tx: sql<number>`sum(${m.txBytes})`
		})
		.from(m)
		.where(
			and(
				eq(m.serviceId, serviceId),
				eq(m.environmentId, environmentId),
				eq(m.step, step),
				gte(m.bucket, from)
			)
		)
		.groupBy(m.bucket)
		.orderBy(m.bucket)
		.all();
	const points: ServiceMetricPoint[] = rows.map((r) => ({
		at: new Date(r.bucket).toISOString(),
		cpuPercent: round(r.cpu),
		cpuMaxPercent: round(r.cpuMax),
		memoryMb: round(r.memory),
		memoryMaxMb: round(r.memoryMax),
		memoryLimitMb: r.limit === null ? null : round(r.limit),
		rxBytesPerSecond: round(r.rx / step),
		txBytesPerSecond: round(r.tx / step)
	}));
	return { range, step, points };
}

export function nodeMetrics(
	db: DbOrTx,
	nodeId: string,
	range: MetricRange,
	now = Date.now()
): NodeMetrics {
	const { step, from } = window(range, now);
	const m = nodeMetric;
	const points: NodeMetricPoint[] = db
		.select()
		.from(m)
		.where(and(eq(m.nodeId, nodeId), eq(m.step, step), gte(m.bucket, from)))
		.orderBy(m.bucket)
		.all()
		.map((r) => ({
			at: new Date(r.bucket).toISOString(),
			cpuPercent: round(r.cpuSum / r.samples),
			cpuMaxPercent: round(r.cpuMax),
			memoryUsedMb: round(r.memoryUsedSum / r.samples),
			memoryTotalMb: r.memoryTotal,
			diskUsedMb: r.diskUsed,
			diskTotalMb: r.diskTotal
		}));
	return { range, step, points };
}
