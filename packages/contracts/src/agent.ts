import { z } from 'zod';
import { ScanMode, ScanResult } from './scan';

/**
 * Protocol between the control plane and node agents.
 *
 * Agents dial out over HTTPS (works behind NAT): they long-poll for the node's
 * full desired state, converge the local Docker daemon towards it, and report
 * what is actually running. Every exchange is idempotent.
 */

export const AGENT_PROTOCOL_VERSION = 1;

/** Sent when an agent starts, and whenever its environment changes. */
export const AgentHello = z.object({
	protocol: z.literal(AGENT_PROTOCOL_VERSION),
	agentVersion: z.string(),
	hostname: z.string(),
	os: z.string(),
	arch: z.string(),
	cpus: z.number().int().nonnegative(),
	memoryMb: z.number().int().nonnegative(),
	/** null when the Docker daemon is unreachable. */
	docker: z.object({ version: z.string() }).nullable(),
	dockerError: z.string().nullable().optional()
});

export type AgentHello = z.infer<typeof AgentHello>;

export const DesiredContainer = z.object({
	/** Stable name, e.g. `tl-dep_123-0`; also the Docker container name. */
	name: z.string(),
	deploymentId: z.string(),
	serviceId: z.string(),
	environmentId: z.string(),
	replica: z.number().int().nonnegative(),
	image: z.string(),
	/** Run through `/bin/sh -c` when set. */
	command: z.string().nullable(),
	env: z.record(z.string(), z.string()),
	network: z.string(),
	/** DNS names on `network`: the service's private domain and a per-deployment alias. */
	aliases: z.array(z.string()),
	restartPolicy: z.enum(['on_failure', 'always', 'never']),
	port: z.number().int().nullable(),
	healthcheckPath: z.string().nullable(),
	memoryMb: z.number().int().nullable(),
	readOnlyRootFilesystem: z.boolean()
});

export type DesiredContainer = z.infer<typeof DesiredContainer>;

/** Build a deployment's image from source. The agent reports progress in `AgentReport.builds`. */
export const DesiredBuild = z.object({
	deploymentId: z.string(),
	serviceId: z.string(),
	/** Clone URL without credentials. */
	repo: z.string(),
	/** Branch to build, or the commit to check out when known (e.g. from a push). */
	ref: z.string(),
	commit: z.string().nullable(),
	/** Short-lived credential for private repositories (a GitHub installation token). */
	token: z.string().nullable(),
	rootDirectory: z.string(),
	builder: z.enum(['railpack', 'dockerfile']),
	dockerfilePath: z.string().nullable(),
	buildCommand: z.string().nullable(),
	startCommand: z.string().nullable(),
	/** Tag for the resulting image, e.g. `tramline/svc_1:dep_1`. */
	image: z.string(),
	/** Passed as BuildKit secrets: available to build steps, never stored in the image or logs. */
	secrets: z.record(z.string(), z.string()),
	scan: ScanMode.default('warn')
});

export type DesiredBuild = z.infer<typeof DesiredBuild>;

/**
 * Pull a registry image and scan it before it runs. Reported like a build,
 * with `image` set to the exact digest that was scanned.
 */
export const DesiredScan = z.object({
	deploymentId: z.string(),
	image: z.string(),
	scan: ScanMode.exclude(['off'])
});

export type DesiredScan = z.infer<typeof DesiredScan>;

export const IngressRoute = z.object({
	host: z.string(),
	/** `alias:port` reachable on one of the environment networks. */
	upstreams: z.array(z.string()),
	network: z.string()
});

export type IngressRoute = z.infer<typeof IngressRoute>;

export const DesiredState = z.object({
	/** Hash of the document; the agent echoes it to long-poll for changes. */
	revision: z.string(),
	networks: z.array(z.string()),
	containers: z.array(DesiredContainer),
	builds: z.array(DesiredBuild),
	scans: z.array(DesiredScan).default([]),
	ingress: z.object({
		httpPort: z.number().int(),
		/** Serve HTTPS with automatic certificates (real domains only). */
		tls: z.boolean(),
		routes: z.array(IngressRoute)
	})
});

export type DesiredState = z.infer<typeof DesiredState>;

export const CONTAINER_STATES = [
	'pulling',
	'starting',
	'running',
	'restarting',
	'exited',
	'error'
] as const;

export const ActualContainer = z.object({
	name: z.string(),
	deploymentId: z.string(),
	replica: z.number().int(),
	state: z.enum(CONTAINER_STATES),
	/** null when the deployment has no healthcheck, or it hasn't run yet. */
	healthy: z.boolean().nullable(),
	exitCode: z.number().int().nullable(),
	restartCount: z.number().int(),
	/** e.g. an image pull failure. */
	error: z.string().nullable(),
	startedAt: z.iso.datetime().nullable(),
	/** `repo@sha256:…` of the image the container runs, when the registry provided one. */
	imageDigest: z.string().nullable().optional()
});

export type ActualContainer = z.infer<typeof ActualContainer>;

export const BuildReport = z.object({
	deploymentId: z.string(),
	state: z.enum(['running', 'succeeded', 'failed']),
	/** Image ID (`sha256:…`) once built. */
	image: z.string().nullable(),
	/** The commit that was built. */
	commit: z.string().nullable(),
	error: z.string().nullable(),
	scan: ScanResult.nullable().optional()
});

export type BuildReport = z.infer<typeof BuildReport>;

/** What the agent observed; replaces the previous report for the node. */
export const AgentReport = z.object({
	containers: z.array(ActualContainer),
	builds: z.array(BuildReport).default([]),
	/** The desired revision the agent last converged to. */
	revision: z.string().nullable(),
	dockerError: z.string().nullable().optional()
});

export type AgentReport = z.infer<typeof AgentReport>;
/** A report before defaults are applied (e.g. `builds` may be omitted). */
export type AgentReportInput = z.input<typeof AgentReport>;

export const LogLine = z.object({
	deploymentId: z.string(),
	/** ISO timestamp from Docker. */
	ts: z.string(),
	stream: z.enum(['stdout', 'stderr', 'build', 'system']),
	line: z.string()
});

export type LogLine = z.infer<typeof LogLine>;

export const LogBatch = z.object({ lines: z.array(LogLine).max(5000) });
export type LogBatch = z.infer<typeof LogBatch>;

export const NodeSummary = z.object({
	id: z.string(),
	name: z.string(),
	status: z.enum(['online', 'offline', 'error']),
	/** Why the node can't run workloads, e.g. "Docker isn't running". */
	error: z.string().nullable(),
	lastSeenAt: z.iso.datetime().nullable(),
	hostname: z.string().nullable(),
	dockerVersion: z.string().nullable()
});

export type NodeSummary = z.infer<typeof NodeSummary>;
