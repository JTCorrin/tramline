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

export const ALERT_KINDS = [
	'node_offline',
	'node_disk',
	'node_memory',
	'service_memory',
	'service_security'
] as const;
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

/** What a service's containers tried that containment blocked, in one minute. */
export const SecurityEvent = z.object({
	deploymentId: z.string(),
	nodeId: z.string().nullable(),
	nodeName: z.string().nullable(),
	kind: z.enum(['metadata', 'private', 'host', 'scan']),
	count: z.number().int(),
	/** The start of the minute. */
	at: z.iso.datetime()
});
export type SecurityEvent = z.infer<typeof SecurityEvent>;

/** Requests from the last hour, day or week; the Traffic tab's filters. */
export const TrafficQuery = z.object({
	environmentId: z.string(),
	range: z.enum(['1h', '24h', '7d']).default('24h'),
	/** e.g. `4xx`, or `tcp` for connections to the TCP proxy. */
	status: z.enum(['2xx', '3xx', '4xx', '5xx', 'tcp']).optional(),
	client: z.string().max(64).optional(),
	asn: z.coerce.number().int().optional(),
	/** Paths containing this. */
	path: z.string().max(256).optional()
});
export type TrafficQuery = z.infer<typeof TrafficQuery>;

/** One request to a service's public domain, or one connection to its TCP proxy. */
export const TrafficEntry = z.object({
	at: z.iso.datetime(),
	kind: z.enum(['http', 'tcp']),
	host: z.string().nullable(),
	method: z.string().nullable(),
	path: z.string().nullable(),
	/** HTTP status; null for TCP. */
	status: z.number().int().nullable(),
	/** TCP: proxied, refused (not on the allowlist) or plaintext (didn't start TLS). */
	outcome: z.string().nullable(),
	durationMs: z.number(),
	bytes: z.number().int(),
	/** The visitor's address; ends in .0 (or ::) when addresses are anonymised. */
	client: z.string(),
	asn: z.number().int().nullable(),
	/** Who the address belongs to, e.g. "GOOGLE-CLOUD-PLATFORM"; null when unknown. */
	network: z.string().nullable(),
	userAgent: z.string().nullable(),
	nodeName: z.string().nullable(),
	/** How many requests this one stands for: more than 1 when successes were sampled. */
	weight: z.number().int()
});
export type TrafficEntry = z.infer<typeof TrafficEntry>;

export const Traffic = z.object({
	/** Requests and connections matching the filters, counting sampled ones at their weight. */
	total: z.number().int(),
	statuses: z.array(z.object({ status: z.string(), count: z.number().int() })),
	topClients: z.array(
		z.object({ client: z.string(), network: z.string().nullable(), count: z.number().int() })
	),
	topNetworks: z.array(
		z.object({
			asn: z.number().int().nullable(),
			network: z.string().nullable(),
			count: z.number().int()
		})
	),
	/** The newest 200. */
	entries: z.array(TrafficEntry),
	settings: z.object({
		retentionDays: z.number().int(),
		anonymised: z.boolean(),
		/** Whether network names are available (the IP-to-ASN data is loaded). */
		networks: z.boolean()
	})
});
export type Traffic = z.infer<typeof Traffic>;
