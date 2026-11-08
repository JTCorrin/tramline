import { z } from 'zod';

/**
 * Node pools: machines Tramline creates and destroys by itself. A pool is an
 * adapter account, a region and a size. When a deployment can't be placed
 * anywhere and would fit that size, the pool adds a machine (up to its
 * maximum and spend cap); a machine that has run nothing for `idleMinutes`
 * is destroyed (down to its minimum).
 */

const POOL_NAME = z
	.string()
	.trim()
	.min(1)
	.max(30)
	.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
		message: 'Use lowercase letters, numbers and dashes'
	});

const limits = {
	minNodes: z.number().int().min(0).max(50),
	maxNodes: z.number().int().min(0).max(50),
	/** Destroy a machine after it has run nothing for this long. */
	idleMinutes: z
		.number()
		.int()
		.min(5)
		.max(7 * 24 * 60),
	/** Never grow past this estimated monthly cost, in the offer's currency (USD). */
	monthlyCap: z.number().positive().max(1_000_000).nullable()
};

export const NodePool = z.object({
	id: z.string(),
	name: z.string(),
	account: z.object({ id: z.string(), name: z.string(), adapter: z.string() }),
	region: z.string(),
	offer: z.object({
		id: z.string(),
		name: z.string(),
		vcpus: z.number().int(),
		memoryMb: z.number().int(),
		/** Its GPUs; a pool of GPU machines only grows for work that needs GPUs. */
		gpu: z
			.object({ model: z.string(), count: z.number().int(), vramGb: z.number().nullable() })
			.nullable(),
		/** null when the provider doesn't say (e.g. Proxmox without a price). */
		hourly: z.number().nullable()
	}),
	/** The environment it serves, or null for every environment. */
	environment: z.object({ id: z.string(), name: z.string(), project: z.string() }).nullable(),
	/** It was for an environment that has since been deleted; it only shrinks. */
	orphaned: z.boolean(),
	...limits,
	/** Its machines: enrolled nodes, and ones still being created. */
	nodes: z.array(
		z.object({ id: z.string(), name: z.string(), idleSince: z.iso.datetime().nullable() })
	),
	provisioning: z.number().int(),
	/** Estimated monthly cost now, and at its maximum (730 hours a month). */
	monthly: z.object({ now: z.number(), max: z.number() }).nullable(),
	/** Removing: its machines are draining, and it goes once they're destroyed. */
	removing: z.boolean(),
	/** What the autoscaler last couldn't do, e.g. a provider error. */
	error: z.string().nullable(),
	errorAt: z.iso.datetime().nullable(),
	/** The latest thing the autoscaler did, e.g. "Added web-7f3a for a waiting deployment". */
	activity: z.string().nullable(),
	activityAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime()
});
export type NodePool = z.infer<typeof NodePool>;

export const CreateNodePool = z
	.object({
		name: POOL_NAME,
		account: z.string().min(1),
		region: z.string().min(1),
		offer: z.string().min(1),
		environmentId: z.string().nullable().default(null),
		minNodes: limits.minNodes.default(0),
		maxNodes: limits.maxNodes.default(3),
		idleMinutes: limits.idleMinutes.default(15),
		monthlyCap: limits.monthlyCap.default(null)
	})
	.refine((p) => p.minNodes <= p.maxNodes, {
		message: 'The minimum is more than the maximum',
		path: ['minNodes']
	});
export type CreateNodePool = z.input<typeof CreateNodePool>;

export const UpdateNodePool = z.object(limits).partial();
export type UpdateNodePool = z.infer<typeof UpdateNodePool>;

/** A machine an account's provider runs, carrying Tramline's tag, that no node or pending machine accounts for. */
export const LeftoverMachine = z.object({
	id: z.string(),
	name: z.string(),
	region: z.string().nullable(),
	status: z.string(),
	address: z.string().nullable()
});
export type LeftoverMachine = z.infer<typeof LeftoverMachine>;
