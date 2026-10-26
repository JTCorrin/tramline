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
	dockerError: z.string().nullable().optional(),
	/**
	 * This node's WireGuard identity. The private key never leaves the node.
	 * `endpoint` is where other nodes can reach it (`host:port`, UDP), or null
	 * behind NAT.
	 */
	mesh: z
		.object({
			publicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
			endpoint: z.string().nullable()
		})
		.nullable()
		.optional()
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
	readOnlyRootFilesystem: z.boolean(),
	/** Named volumes the agent creates (labelled as its own) and mounts. */
	volumes: z.array(z.object({ name: z.string(), target: z.string() })).default([]),
	/**
	 * Serve TLS with a certificate the agent creates on the node for these
	 * names (the key never leaves the node). Postgres only for now.
	 */
	tls: z
		.object({ kind: z.literal('postgres'), names: z.array(z.string()).min(1) })
		.nullable()
		.default(null)
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

/**
 * Back up a volume: a native dump taken inside the running database
 * container, or an archive of the volume. The agent compresses and encrypts
 * it with `key`, then uploads it to `url`, a presigned URL that allows only
 * that one upload. `url` and `key` are attached when the state is served.
 */
export const DesiredBackup = z.object({
	id: z.string(),
	kind: z.enum(['postgres', 'mysql', 'mongo', 'volume']),
	/** The running database container, for native dumps. */
	container: z.string().nullable(),
	volume: z.string(),
	url: z.string().nullable().default(null),
	/** base64 AES-256 key. */
	key: z.string().nullable().default(null)
});

export type DesiredBackup = z.infer<typeof DesiredBackup>;

/**
 * Restore a backup: native dumps are loaded into the running database;
 * volume archives replace the volume's contents while the service's
 * containers are stopped (they start again afterwards).
 */
export const DesiredRestore = z.object({
	id: z.string(),
	kind: DesiredBackup.shape.kind,
	/** The running database container, for native dumps. */
	container: z.string().nullable(),
	/** Containers using the volume; stopped during a volume restore. */
	stop: z.array(z.string()),
	volume: z.string(),
	url: z.string().nullable().default(null),
	key: z.string().nullable().default(null)
});

export type DesiredRestore = z.infer<typeof DesiredRestore>;

/**
 * A restore drill: fetch a backup and prove it can be restored, without
 * touching the service. Postgres dumps are loaded into a throwaway container
 * of `image`; other backups are fully decrypted, decompressed and parsed.
 */
export const DesiredDrill = z.object({
	id: z.string(),
	kind: DesiredBackup.shape.kind,
	/** The database's image, for a scratch restore. */
	image: z.string().nullable(),
	url: z.string().nullable().default(null),
	key: z.string().nullable().default(null)
});

export type DesiredDrill = z.infer<typeof DesiredDrill>;

/**
 * A read-only query for the data browser: the agent runs `sql` with psql
 * inside the database container (in a READ ONLY transaction with a statement
 * timeout) and posts the JSON result to `/api/agent/v1/queries/:id`.
 */
export const DesiredQuery = z.object({
	id: z.string(),
	container: z.string(),
	/** Built by the control plane; it returns one JSON value. */
	sql: z.string()
});

export type DesiredQuery = z.infer<typeof DesiredQuery>;

export const QueryResult = z.discriminatedUnion('ok', [
	z.object({ ok: z.literal(true), json: z.string() }),
	z.object({ ok: z.literal(false), error: z.string() })
]);

export type QueryResult = z.infer<typeof QueryResult>;

export const IngressRoute = z.object({
	host: z.string(),
	/** `alias:port` reachable on one of the environment networks. */
	upstreams: z.array(z.string()),
	network: z.string(),
	/** A user's own domain: HSTS covers this host only, never the domain's other subdomains. */
	custom: z.boolean().optional()
});

export type IngressRoute = z.infer<typeof IngressRoute>;

export const MeshPeer = z.object({
	nodeId: z.string(),
	publicKey: z.string(),
	/** `host:port`; null when the peer is behind NAT and connects to us. */
	endpoint: z.string().nullable(),
	/** Mesh addresses routed to this peer: its own, plus nodes it relays for us. */
	allowedIps: z.array(z.string()),
	/** Keep the tunnel open through our NAT. */
	keepalive: z.boolean()
});

export type MeshPeer = z.infer<typeof MeshPeer>;

/**
 * A TCP port the mesh container forwards. Connections from this node's links
 * (and edge routes) go to the node running the service; connections arriving
 * over the tunnel go to the service itself.
 */
export const MeshForward = z.discriminatedUnion('to', [
	z.object({
		to: z.literal('remote'),
		port: z.number().int(),
		/** The mesh address of the node running the service. */
		address: z.string()
	}),
	z.object({
		to: z.literal('local'),
		port: z.number().int(),
		/** `alias:port` on `network`. */
		target: z.string(),
		network: z.string()
	})
]);

export type MeshForward = z.infer<typeof MeshForward>;

/** Makes a service on another node answer to its private name on this node's environment network. */
export const MeshLink = z.object({
	/** Container name, e.g. `tl-link-env_1-svc_1`. */
	name: z.string(),
	network: z.string(),
	alias: z.string(),
	/** The service's own port, which the link listens on. */
	port: z.number().int(),
	/** The mesh container's port for this service. */
	meshPort: z.number().int()
});

export type MeshLink = z.infer<typeof MeshLink>;

export const DesiredMesh = z.object({
	/** This node's mesh address. */
	address: z.string(),
	/** The whole mesh range, routed into the tunnel. */
	cidr: z.string(),
	listenPort: z.number().int(),
	/** Pass traffic between peers that can't reach each other. */
	relay: z.boolean(),
	peers: z.array(MeshPeer),
	forwards: z.array(MeshForward),
	links: z.array(MeshLink)
});

export type DesiredMesh = z.infer<typeof DesiredMesh>;

/**
 * A public TCP port for one service on an edge node. Connections from
 * outside `allow` are dropped, and a Postgres connection has to start TLS
 * with the database before anything else crosses.
 */
export const TcpProxy = z.object({
	/** Container name, e.g. `tl-tcp-env_1-svc_1`. */
	name: z.string(),
	/** Host port. */
	port: z.number().int(),
	protocol: z.literal('postgres'),
	allow: z.array(z.string()),
	/** `host:port` on `network`. */
	target: z.string(),
	network: z.string()
});

export type TcpProxy = z.infer<typeof TcpProxy>;

export const DesiredState = z.object({
	/** Hash of the document; the agent echoes it to long-poll for changes. */
	revision: z.string(),
	networks: z.array(z.string()),
	containers: z.array(DesiredContainer),
	builds: z.array(DesiredBuild),
	scans: z.array(DesiredScan).default([]),
	/** Volumes of deleted services and environments; the agent removes them once nothing uses them. */
	deletedVolumes: z.array(z.string()).default([]),
	backups: z.array(DesiredBackup).default([]),
	restores: z.array(DesiredRestore).default([]),
	drills: z.array(DesiredDrill).default([]),
	queries: z.array(DesiredQuery).default([]),
	/** null on a single-node install, or before the node has a mesh key. */
	mesh: DesiredMesh.nullable().default(null),
	tcpProxies: z.array(TcpProxy).default([]),
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
/** Progress of a backup or restore; `size` is the uploaded size of a backup. */
export const JobReport = z.object({
	id: z.string(),
	state: z.enum(['running', 'succeeded', 'failed']),
	size: z.number().int().nullable().default(null),
	error: z.string().nullable().default(null),
	/** What a drill found, e.g. "Loaded 2 databases with 14 tables". */
	detail: z.string().nullable().default(null)
});

export type JobReport = z.infer<typeof JobReport>;

export const AgentReport = z.object({
	containers: z.array(ActualContainer),
	builds: z.array(BuildReport).default([]),
	backups: z.array(JobReport).default([]),
	restores: z.array(JobReport).default([]),
	drills: z.array(JobReport).default([]),
	/** Volumes this node's agent manages that exist on the node; absent when Docker can't be asked. */
	volumes: z.array(z.string()).optional(),
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
	dockerVersion: z.string().nullable(),
	/** Which compute adapter manages it; `manual` for machines enrolled by hand. */
	adapter: z.string(),
	cpus: z.number().int().nullable(),
	memoryMb: z.number().int().nullable(),
	/** Memory promised to the deployments placed here (their limits). */
	allocatedMemoryMb: z.number().int(),
	/** Live deployments placed on the node. */
	deployments: z.number().int(),
	/** Takes no new deployments. */
	cordoned: z.boolean(),
	/** Its stateless deployments are moving elsewhere. */
	draining: z.boolean(),
	/** Serves every public domain, forwarding to other nodes over the mesh. */
	edge: z.boolean(),
	mesh: z
		.object({
			address: z.string(),
			/** `host:port`, or null behind NAT. */
			endpoint: z.string().nullable(),
			/** Nodes this one can't reach directly, and none relays for. */
			unreachable: z.array(z.string()),
			/** Peers reached through another node: their name, and the relay's. */
			relayed: z.array(z.object({ node: z.string(), via: z.string() }))
		})
		.nullable(),
	createdAt: z.iso.datetime()
});

export type NodeSummary = z.infer<typeof NodeSummary>;

export const NODE_NAME = z
	.string()
	.trim()
	.min(1)
	.max(40)
	.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
		message: 'Use lowercase letters, numbers and dashes'
	});

export const CreateJoinToken = z.object({
	name: NODE_NAME,
	/** Enroll it cordoned, to look it over before it takes deployments. */
	cordoned: z.boolean().default(false)
});
export type CreateJoinToken = z.input<typeof CreateJoinToken>;

/** A one-time token for enrolling a machine as a node. Shown once. */
export const CreatedJoinToken = z.object({
	name: z.string(),
	token: z.string(),
	expiresAt: z.iso.datetime(),
	/** Ready to paste into a shell on the new machine. */
	command: z.string()
});
export type CreatedJoinToken = z.infer<typeof CreatedJoinToken>;

export const UpdateNode = z
	.object({
		cordoned: z.boolean(),
		edge: z.boolean(),
		/** Where other nodes reach this one's mesh, `host:port` (UDP); null behind NAT. */
		meshEndpoint: z
			.string()
			.trim()
			.regex(/^[A-Za-z0-9.-]+:\d{1,5}$|^\[[0-9a-fA-F:]+\]:\d{1,5}$/, {
				message: 'Use host:port, e.g. 203.0.113.7:51820'
			})
			.nullable()
	})
	.partial();
export type UpdateNode = z.infer<typeof UpdateNode>;

/** What draining did: deployments moved, and those that stay with their volume. */
export const DrainResult = z.object({
	moved: z.number().int(),
	kept: z.array(z.object({ deploymentId: z.string(), service: z.string() }))
});
export type DrainResult = z.infer<typeof DrainResult>;

/** The agent trades a join token for its own node token, once. */
export const AgentJoin = z.object({ token: z.string().min(1).max(200), hello: AgentHello });
export type AgentJoin = z.infer<typeof AgentJoin>;

export const AgentJoined = z.object({ nodeId: z.string(), name: z.string(), token: z.string() });
export type AgentJoined = z.infer<typeof AgentJoined>;
