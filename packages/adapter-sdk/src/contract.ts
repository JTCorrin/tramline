import { z } from 'zod';

/**
 * The contract every compute adapter implements. The control plane only
 * talks to this, so scheduling, pricing and the UI never contain provider
 * code. An adapter only provisions a machine: once it boots, the agent
 * enrolls itself with the join token in its spec, the same way everywhere.
 */

export const Arch = z.enum(['amd64', 'arm64']);
export type Arch = z.infer<typeof Arch>;

/** Where machines can be created: a cloud region, or a Proxmox cluster node. */
export const Region = z.object({ id: z.string().min(1), name: z.string().min(1) });
export type Region = z.infer<typeof Region>;

/** The GPUs a machine size comes with. */
export const Gpu = z.object({
	model: z.string().min(1),
	count: z.number().int().positive(),
	/** Per GPU; null when the provider doesn't say. */
	vramGb: z.number().positive().nullable()
});
export type Gpu = z.infer<typeof Gpu>;

/** A machine size in a region, and what it costs. Offers feed price comparison. */
export const Offer = z.object({
	id: z.string().min(1),
	region: z.string().min(1),
	name: z.string().min(1),
	vcpus: z.number().int().positive(),
	memoryMb: z.number().int().positive(),
	diskGb: z.number().int().positive().nullable(),
	arch: Arch,
	gpu: Gpu.nullable(),
	/** US dollars an hour; null when unknown (hardware you own, say). */
	hourly: z.number().nonnegative().nullable(),
	spotHourly: z.number().nonnegative().nullable(),
	egressPerGb: z.number().nonnegative().nullable()
});
export type Offer = z.infer<typeof Offer>;

/** A machine as the provider sees it. */
export const ProviderNode = z.object({
	/** The provider's ID for it, used to look it up and destroy it. */
	id: z.string().min(1),
	name: z.string().min(1),
	region: z.string().nullable(),
	status: z.enum(['provisioning', 'running', 'stopped', 'error', 'unknown']),
	/** Its public or LAN address, once known. */
	address: z.string().nullable(),
	/** What a person has to do for it to enroll, when the adapter can't (e.g. run a command). */
	instructions: z.string().nullable()
});
export type ProviderNode = z.infer<typeof ProviderNode>;

/** What the control plane asks an adapter to create. */
export interface NodeSpec {
	/** The Tramline node name; adapters name the machine after it. */
	name: string;
	region: string;
	offer: string;
	install: {
		/** Where the agent reaches this install. */
		url: string;
		/** One-time join token; it expires after an hour. */
		token: string;
		/** The shell command that enrolls a machine that already has Docker. */
		command: string;
	};
	/** Cloud-init user data that installs Docker and enrolls the machine. */
	userData: string;
}

export interface AdapterCapabilities {
	spot: boolean;
	arch: Arch[];
	/** Machines can be created through the provider's API, without a person. */
	autoProvision: boolean;
	/** Some offers come with GPUs. */
	gpus: boolean;
	/**
	 * `getNode` and `listNodes` see the provider's machines. False for an
	 * adapter that only hands back instructions, which then has nothing to list.
	 */
	inventory: boolean;
}

export interface ComputeAdapter<Creds = unknown> {
	meta: {
		/** Stable, lowercase: stored with accounts and nodes. */
		id: string;
		name: string;
		/** A lucide icon name. */
		icon: string;
		description: string;
	};
	/**
	 * Drives the "Connect account" form. Mark secret fields with
	 * `.meta({ secret: true })`: they're stored encrypted and never shown again.
	 */
	credentials: z.ZodType<Creds>;
	capabilities: AdapterCapabilities;
	/** "Test connection": throws a message a person can act on. */
	validate(creds: Creds): Promise<void>;
	listRegions(creds: Creds): Promise<Region[]>;
	listOffers(creds: Creds, region: string): Promise<Offer[]>;
	createNode(creds: Creds, spec: NodeSpec): Promise<ProviderNode>;
	/** null once the machine is gone. */
	getNode(creds: Creds, id: string): Promise<ProviderNode | null>;
	/** Machines this adapter created, to find orphans and drift. */
	listNodes(creds: Creds): Promise<ProviderNode[]>;
	/** Idempotent: destroying a machine that's already gone succeeds. */
	destroyNode(creds: Creds, id: string): Promise<void>;
}

/** Declares an adapter, keeping its credentials type. */
export const defineAdapter = <Creds>(adapter: ComputeAdapter<Creds>) => adapter;

/**
 * A failure the person connecting an account can act on, e.g. "The API
 * token was rejected". The control plane shows its message as it is.
 */
export class AdapterError extends Error {
	override name = 'AdapterError';
}
