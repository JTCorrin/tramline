import { z } from 'zod';
import { ScanMode } from './scan';

export const SERVICE_KINDS = ['image', 'repo', 'database', 'empty'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export const DATABASE_ENGINES = ['postgres', 'mysql', 'redis', 'mongo'] as const;
export type DatabaseEngine = (typeof DATABASE_ENGINES)[number];

export const Position = z.object({ x: z.number(), y: z.number() });
export type Position = z.infer<typeof Position>;

export const Service = z.object({
	id: z.string(),
	projectId: z.string(),
	name: z.string(),
	kind: z.enum(SERVICE_KINDS),
	/** Icon hint for the canvas, e.g. a database engine. */
	icon: z.string().nullable(),
	position: Position,
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime()
});

export type Service = z.infer<typeof Service>;

const serviceName = z
	.string()
	.trim()
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/, 'Use letters, numbers, dashes and underscores');

// ---- per-environment configuration -------------------------------------------

const optionalText = z
	.string()
	.trim()
	.max(500)
	.transform((v) => v || null)
	.nullable();

export const ServiceSource = z.discriminatedUnion('type', [
	z.object({ type: z.literal('image'), image: z.string().trim().min(1, 'Image is required') }),
	z.object({
		type: z.literal('repo'),
		repo: z.string().trim().min(1, 'Repository is required'),
		branch: z.string().trim().min(1),
		rootDirectory: z.string().trim().min(1),
		/** GitHub App installation that grants access to a private repository. */
		installationId: z.string().nullable().optional(),
		/** Deploy every push to `branch` (default true). */
		autoDeploy: z.boolean().optional()
	})
]);

export type ServiceSource = z.infer<typeof ServiceSource>;

export const BuildConfig = z.object({
	builder: z.enum(['railpack', 'dockerfile']),
	dockerfilePath: optionalText,
	buildCommand: optionalText,
	/** Vulnerability scanning of the image before it runs (built and pulled images alike). */
	scan: ScanMode
});

export const RESTART_POLICIES = ['on_failure', 'always', 'never'] as const;

export const DeployConfig = z.object({
	startCommand: optionalText,
	replicas: z.number().int().min(1).max(20),
	healthcheckPath: optionalText,
	restartPolicy: z.enum(RESTART_POLICIES),
	cronSchedule: optionalText,
	/** Hard memory limit; null for no limit. */
	memoryMb: z.number().int().min(16).max(262_144).nullable(),
	/** Mount the container's root filesystem read-only (with a writable /tmp). */
	readOnlyRootFilesystem: z.boolean()
});

export const NetworkingConfig = z.object({
	port: z.number().int().min(1).max(65535).nullable(),
	publicDomain: z.boolean()
});

/** Absolute path inside the container, e.g. `/var/lib/postgresql/data`. */
const mountPath = z
	.string()
	.trim()
	.regex(/^\/[^\0]*$/, 'Use an absolute path, like /data')
	.refine((path) => !['/', '/proc', '/sys', '/dev'].includes(path.replace(/\/+$/, '') || '/'), {
		message: 'Choose a directory for the data, like /data'
	})
	.nullable();

/**
 * One persistent volume per service and environment. Its data survives
 * deploys; detaching it (a null mount path) keeps the data for later.
 */
export const VolumeConfig = z.object({ mountPath });

export const ServiceConfig = z.object({
	source: ServiceSource.nullable(),
	build: BuildConfig,
	deploy: DeployConfig,
	networking: NetworkingConfig,
	volume: VolumeConfig
});

export type ServiceConfig = z.infer<typeof ServiceConfig>;

/** A partial update to a service's configuration. Sections merge shallowly. */
export const ServiceConfigPatch = z.object({
	source: ServiceSource.nullable().optional(),
	build: BuildConfig.partial().optional(),
	deploy: DeployConfig.partial().optional(),
	networking: NetworkingConfig.partial().optional(),
	volume: VolumeConfig.partial().optional()
});

export type ServiceConfigPatch = z.infer<typeof ServiceConfigPatch>;

export const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
	source: null,
	build: { builder: 'railpack', dockerfilePath: null, buildCommand: null, scan: 'warn' },
	deploy: {
		startCommand: null,
		replicas: 1,
		healthcheckPath: null,
		restartPolicy: 'on_failure',
		cronSchedule: null,
		memoryMb: null,
		readOnlyRootFilesystem: false
	},
	networking: { port: null, publicDomain: false },
	volume: { mountPath: null }
};

/** Applies a patch to a config. Used by the server and for optimistic UI. */
export function mergeConfig(base: ServiceConfig, patch: ServiceConfigPatch): ServiceConfig {
	return {
		source: patch.source !== undefined ? patch.source : base.source,
		build: { ...base.build, ...patch.build },
		deploy: { ...base.deploy, ...patch.deploy },
		networking: { ...base.networking, ...patch.networking },
		volume: { ...base.volume, ...patch.volume }
	};
}

export const ServiceConfigView = z.object({
	/** The configuration of the last deploy, or null if the service was never deployed. */
	applied: ServiceConfig.nullable(),
	/** What the next deploy will use: applied config plus staged changes. */
	effective: ServiceConfig,
	staged: z.boolean()
});

export type ServiceConfigView = z.infer<typeof ServiceConfigView>;

// ---- create / update -----------------------------------------------------------

export const CreateService = z.object({
	projectId: z.string(),
	kind: z.enum(SERVICE_KINDS),
	/** Defaults to a name derived from the source. */
	name: serviceName.optional(),
	source: ServiceSource.optional(),
	/** Required when kind is `database`. */
	engine: z.enum(DATABASE_ENGINES).optional(),
	position: Position.optional()
});

export type CreateService = z.infer<typeof CreateService>;

export const UpdateService = z
	.object({ name: serviceName, position: Position, icon: z.string().nullable() })
	.partial();

export type UpdateService = z.infer<typeof UpdateService>;
