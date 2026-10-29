import { z } from 'zod';

/**
 * Resource metrics. Agents sample their node and its workloads every few
 * seconds; the control plane keeps 1-minute buckets for two days and hourly
 * ones for a month.
 */

const percent = z.number().min(0);
const bytes = z.number().int().min(0);

/** One sample of a node. CPU is the share of the whole machine (0–100). */
export const NodeSample = z.object({
	cpuPercent: percent.max(100),
	memoryUsedMb: z.number().int().min(0),
	memoryTotalMb: z.number().int().min(0),
	/** The disk Docker keeps images and volumes on; null when it can't be read. */
	diskUsedMb: z.number().int().min(0).nullable(),
	diskTotalMb: z.number().int().min(0).nullable()
});
export type NodeSample = z.infer<typeof NodeSample>;

/** One sample of a workload container. CPU is in cores × 100, so 2 busy cores is 200. */
export const ContainerSample = z.object({
	deploymentId: z.string(),
	replica: z.number().int().min(0),
	cpuPercent: percent,
	memoryMb: z.number().min(0),
	/** The container's memory limit, or null without one. */
	memoryLimitMb: z.number().min(0).nullable(),
	/** Bytes received and sent since the previous sample. */
	rxBytes: bytes,
	txBytes: bytes
});
export type ContainerSample = z.infer<typeof ContainerSample>;

export const MetricsBatch = z.object({
	at: z.iso.datetime(),
	node: NodeSample.nullable(),
	containers: z.array(ContainerSample).max(1000)
});
export type MetricsBatch = z.infer<typeof MetricsBatch>;

export const METRIC_RANGES = ['1h', '6h', '24h', '7d', '30d'] as const;
export const MetricRange = z.enum(METRIC_RANGES);
export type MetricRange = z.infer<typeof MetricRange>;

/** One bucket of a service's metrics, summed over its replicas. */
export const ServiceMetricPoint = z.object({
	at: z.iso.datetime(),
	cpuPercent: z.number(),
	cpuMaxPercent: z.number(),
	memoryMb: z.number(),
	memoryMaxMb: z.number(),
	memoryLimitMb: z.number().nullable(),
	/** Bytes per second over the bucket. */
	rxBytesPerSecond: z.number(),
	txBytesPerSecond: z.number()
});
export type ServiceMetricPoint = z.infer<typeof ServiceMetricPoint>;

export const NodeMetricPoint = z.object({
	at: z.iso.datetime(),
	cpuPercent: z.number(),
	cpuMaxPercent: z.number(),
	memoryUsedMb: z.number(),
	memoryTotalMb: z.number(),
	diskUsedMb: z.number().nullable(),
	diskTotalMb: z.number().nullable()
});
export type NodeMetricPoint = z.infer<typeof NodeMetricPoint>;

export const MetricSeries = <T extends z.ZodType>(point: T) =>
	z.object({
		range: MetricRange,
		/** Seconds per point: 60 for ranges up to a day, 3600 beyond. */
		step: z.number().int(),
		points: z.array(point)
	});

export const ServiceMetrics = MetricSeries(ServiceMetricPoint);
export type ServiceMetrics = z.infer<typeof ServiceMetrics>;
export const NodeMetrics = MetricSeries(NodeMetricPoint);
export type NodeMetrics = z.infer<typeof NodeMetrics>;

export const ALERT_KINDS = ['node_offline', 'node_disk', 'node_memory', 'service_memory'] as const;
export const AlertKind = z.enum(ALERT_KINDS);
export type AlertKind = z.infer<typeof AlertKind>;

export const Alert = z.object({
	id: z.string(),
	kind: AlertKind,
	/** The node, or the service in an environment. */
	nodeId: z.string().nullable(),
	serviceId: z.string().nullable(),
	environmentId: z.string().nullable(),
	/** e.g. "Disk on oldking is 93% full". */
	message: z.string(),
	openedAt: z.iso.datetime(),
	resolvedAt: z.iso.datetime().nullable()
});
export type Alert = z.infer<typeof Alert>;
