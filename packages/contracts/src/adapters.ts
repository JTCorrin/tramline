import { z } from 'zod';
import { NODE_NAME } from './agent';
import { GpuRequest } from './services';

/**
 * Compute adapters and the accounts that connect them. Accounts belong to the
 * install, like nodes, and only install admins manage them. Credentials are
 * stored encrypted; secret fields never come back.
 */

/** One field of an adapter's generated "Connect account" form. */
export const CredentialField = z.object({
	key: z.string(),
	label: z.string(),
	description: z.string().nullable(),
	type: z.enum(['string', 'number', 'boolean', 'enum']),
	options: z.array(z.string()).nullable(),
	required: z.boolean(),
	/** Never shown again once saved; left blank, the saved value stays. */
	secret: z.boolean(),
	/** Several lines, e.g. a PEM certificate or a JSON key. */
	multiline: z.boolean(),
	placeholder: z.string().nullable(),
	default: z.union([z.string(), z.number(), z.boolean()]).nullable()
});
export type CredentialField = z.infer<typeof CredentialField>;

export const AdapterInfo = z.object({
	id: z.string(),
	name: z.string(),
	icon: z.string(),
	description: z.string(),
	capabilities: z.object({
		spot: z.boolean(),
		arch: z.array(z.enum(['amd64', 'arm64'])),
		autoProvision: z.boolean(),
		gpus: z.boolean(),
		inventory: z.boolean(),
		/** Tramline opens TCP 80 and 443 in the provider's firewall for edge nodes. */
		edgePorts: z.boolean()
	}),
	/** Empty for an adapter that needs no account (`manual`). */
	fields: z.array(CredentialField)
});
export type AdapterInfo = z.infer<typeof AdapterInfo>;

export const AdapterAccount = z.object({
	id: z.string(),
	adapter: z.string(),
	name: z.string(),
	/** The saved credentials, without secret fields. */
	credentials: z.record(z.string(), z.unknown()),
	/** Nodes it provisioned that are enrolled, or still waiting to. */
	nodes: z.number().int(),
	createdAt: z.iso.datetime()
});
export type AdapterAccount = z.infer<typeof AdapterAccount>;

const CredentialInput = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export const CreateAdapterAccount = z.object({
	adapter: z.string().min(1),
	name: z.string().trim().min(1).max(60),
	credentials: CredentialInput
});
export type CreateAdapterAccount = z.infer<typeof CreateAdapterAccount>;

export const UpdateAdapterAccount = z
	.object({ name: z.string().trim().min(1).max(60), credentials: CredentialInput })
	.partial();
export type UpdateAdapterAccount = z.infer<typeof UpdateAdapterAccount>;

export const AdapterRegion = z.object({ id: z.string(), name: z.string() });
export type AdapterRegion = z.infer<typeof AdapterRegion>;

export const AdapterOffer = z.object({
	id: z.string(),
	region: z.string(),
	name: z.string(),
	vcpus: z.number().int(),
	memoryMb: z.number().int(),
	diskGb: z.number().int().nullable(),
	arch: z.enum(['amd64', 'arm64']),
	gpu: z
		.object({ model: z.string(), count: z.number().int(), vramGb: z.number().nullable() })
		.nullable(),
	hourly: z.number().nullable(),
	spotHourly: z.number().nullable(),
	egressPerGb: z.number().nullable()
});
export type AdapterOffer = z.infer<typeof AdapterOffer>;

export const ProvisionNode = z.object({
	account: z.string().min(1),
	name: NODE_NAME,
	region: z.string().min(1),
	offer: z.string().min(1),
	cordoned: z.boolean().default(false)
});
export type ProvisionNode = z.input<typeof ProvisionNode>;

/** A machine an adapter created that hasn't enrolled, or never did. */
export const ProvisioningNode = z.object({
	id: z.string(),
	name: z.string(),
	account: z.object({ id: z.string(), name: z.string(), adapter: z.string() }),
	/** The provider's ID for the machine. */
	machine: z.string().nullable(),
	region: z.string().nullable(),
	offer: z.string().nullable(),
	/** Past it, the join token no longer works and the machine can't enroll. */
	expiresAt: z.iso.datetime(),
	expired: z.boolean(),
	createdAt: z.iso.datetime()
});
export type ProvisioningNode = z.infer<typeof ProvisioningNode>;

/** What provisioning started: the join token's ID, and the machine as the provider sees it. */
export const ProviderNodeCreated = z.object({
	id: z.string(),
	name: z.string(),
	expiresAt: z.iso.datetime(),
	machine: z.object({
		id: z.string(),
		name: z.string(),
		region: z.string().nullable(),
		status: z.enum(['provisioning', 'running', 'stopped', 'error', 'unknown']),
		address: z.string().nullable(),
		/** What a person must do for it to enroll, when the adapter can't. */
		instructions: z.string().nullable()
	})
});
export type ProviderNodeCreated = z.infer<typeof ProviderNodeCreated>;

/** What a workload needs, to see where it could run and what that costs. */
export const PlacementRequest = z.object({
	vcpus: z.number().positive().max(512),
	memoryMb: z.number().int().min(64).max(4_194_304),
	/** Any architecture when absent. */
	arch: z.enum(['amd64', 'arm64']).optional(),
	gpus: GpuRequest.nullable().default(null),
	/** Rank by spot prices where there are any: cheaper, but the provider may take the machine back. */
	spot: z.boolean().default(false),
	/** Regions to price now, besides the ones already kept. */
	regions: z
		.array(z.object({ account: z.string().min(1), region: z.string().min(1).max(64) }))
		.max(20)
		.default([])
});
export type PlacementRequest = z.input<typeof PlacementRequest>;

/** Where a workload could run: free room on nodes first, then machine sizes, cheapest first. */
export const Placement = z.object({
	/** Nodes with room for it now, which costs nothing more. */
	existing: z.array(
		z.object({
			nodeId: z.string(),
			name: z.string(),
			freeCpus: z.number(),
			freeMemoryMb: z.number().int(),
			freeGpus: z.number().int()
		})
	),
	offers: z.array(
		z.object({
			account: z.object({ id: z.string(), name: z.string(), adapter: z.string() }),
			offer: AdapterOffer,
			/** The price ranked by: spot when asked for and offered, else on-demand. */
			hourly: z.number().nullable(),
			/** `hourly` over an average month (730 hours). */
			monthly: z.number().nullable(),
			spot: z.boolean(),
			fetchedAt: z.iso.datetime()
		})
	),
	/** The regions compared, and how their last price refresh went. */
	regions: z.array(
		z.object({
			account: z.object({ id: z.string(), name: z.string() }),
			region: z.string(),
			fetchedAt: z.iso.datetime().nullable(),
			error: z.string().nullable()
		})
	)
});
export type Placement = z.infer<typeof Placement>;
