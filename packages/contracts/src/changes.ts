import { z } from 'zod';
import { DEPLOYMENT_STATUSES } from './deployments';
import { SERVICE_KINDS } from './services';

export const StagedChange = z.object({
	/** null for shared variables. */
	serviceId: z.string().nullable(),
	label: z.string(),
	/** Human readable lines, e.g. `+ DATABASE_URL`, `deploy.replicas: 1 → 2`. */
	details: z.array(z.string())
});

export type StagedChange = z.infer<typeof StagedChange>;

export const StagedChanges = z.object({
	environmentId: z.string(),
	count: z.number(),
	changes: z.array(StagedChange)
});

export type StagedChanges = z.infer<typeof StagedChanges>;

export const CanvasService = z.object({
	id: z.string(),
	name: z.string(),
	kind: z.enum(SERVICE_KINDS),
	icon: z.string().nullable(),
	position: z.object({ x: z.number(), y: z.number() }),
	/** e.g. `postgres:17` or `acme/api@main`. */
	source: z.string().nullable(),
	status: z.enum([...DEPLOYMENT_STATUSES, 'undeployed']),
	staged: z.boolean(),
	publicDomain: z.boolean()
});

export type CanvasService = z.infer<typeof CanvasService>;

export const CanvasEdge = z.object({ id: z.string(), source: z.string(), target: z.string() });
export type CanvasEdge = z.infer<typeof CanvasEdge>;

/** Everything the project canvas renders for one environment. */
export const Canvas = z.object({
	environmentId: z.string(),
	services: z.array(CanvasService),
	edges: z.array(CanvasEdge)
});

export type Canvas = z.infer<typeof Canvas>;

/** Server-sent event telling clients what to refetch. */
export const ProjectEvent = z.object({
	type: z.enum(['services', 'config', 'variables', 'changes', 'deployments', 'environments']),
	projectId: z.string(),
	environmentId: z.string().optional(),
	serviceId: z.string().optional()
});

export type ProjectEvent = z.infer<typeof ProjectEvent>;
