import {
	AdapterError,
	cloudInit,
	defineAdapter,
	type Gpu,
	type Offer,
	type ProviderNode,
	type Region
} from '@tramline/adapter-sdk';
import { generateKeyPairSync } from 'node:crypto';
import { z } from 'zod';
import { LambdaClient, LambdaError, type ClientOptions } from './client';

/**
 * Lambda Cloud: one on-demand GPU instance per node, from Lambda's default
 * image (Ubuntu with Lambda Stack: NVIDIA drivers, CUDA, Docker and the
 * NVIDIA container toolkit), so cloud-init finds Docker and goes straight to
 * enrolling. Lambda takes cloud-init in `user_data`.
 *
 * Instances carry the tag `tramline=node` and the SSH key
 * `tramline-no-login`, whose private half is never kept (Lambda requires
 * exactly one key). The adapter only lists and terminates instances with
 * either mark. Lambda's firewall rules are one list for the whole account,
 * replaced on every write, so the mesh rule (UDP 51820) is added to what's
 * there, and nothing else is changed. See docs/adapters/lambda.md.
 */

export const TAG = 'tramline';
export const SSH_KEY_NAME = 'tramline-no-login';
export const MESH_PORT = 51820;
const MESH_RULE = {
	protocol: 'udp',
	port_range: [MESH_PORT, MESH_PORT],
	source_network: '0.0.0.0/0',
	description: 'Tramline: WireGuard mesh between nodes'
};
/** Lambda's docs: firewall rules don't apply in this region. */
const NO_FIREWALL = new Set(['us-south-1']);
/**
 * Prints the machine's own address if it's a public one. Lambda has no
 * documented metadata server, so this reads the address the default route
 * uses, and prints nothing when that's private (behind NAT, say).
 */
export const LOCAL_PUBLIC_ADDRESS =
	"ip -4 -o route get 1.1.1.1 | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p' | grep -Ev '^(10|127|0)\\.|^169\\.254\\.|^192\\.168\\.|^172\\.(1[6-9]|2[0-9]|3[01])\\.|^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.'";

const credentials = z.object({
	apiKey: z.string().trim().regex(/^\S+$/, 'Paste the whole API key, with no spaces').meta({
		title: 'API key',
		description:
			'From API keys in the Lambda Cloud dashboard. It can launch and terminate instances, so Tramline keeps it encrypted.',
		secret: true
	}),
	openMeshPort: z
		.boolean()
		.default(true)
		.meta({
			title: 'Open the mesh port',
			description: `Adds a rule for UDP ${MESH_PORT} to the account’s firewall rules, which apply to all its instances. Rules already there stay.`
		})
});

export type LambdaCredentials = z.infer<typeof credentials>;

interface LambdaRegion {
	name: string;
	description: string;
}

interface InstanceType {
	name: string;
	description: string;
	gpu_description: string;
	price_cents_per_hour: number;
	specs: { vcpus: number; memory_gib: number; storage_gib: number; gpus: number };
	architecture?: 'x86_64' | 'arm64';
}

interface Instance {
	id: string;
	name?: string;
	ip?: string;
	status: 'booting' | 'active' | 'unhealthy' | 'terminated' | 'terminating' | 'preempted';
	ssh_key_names: string[];
	region: LambdaRegion;
	instance_type: InstanceType;
	tags?: { key: string; value: string }[];
}

interface FirewallRule {
	protocol: string;
	port_range?: [number, number];
	source_network: string;
	description: string;
}

/** GPU makers whose names don't get "NVIDIA " in front. */
const OTHER_MAKERS = /^(nvidia|amd|intel|radeon|instinct|gaudi)\b/i;

/**
 * The GPUs in a Lambda instance type, from its `gpu_description` (e.g.
 * "A10 (24 GB PCIe)") or, failing that, its description ("1x A10 (24 GB
 * PCIe)"). The count comes from the specs when they have one. Linear in the
 * length of the text: no backtracking patterns, and long text is cut short.
 */
export function parseGpu(
	type: Pick<InstanceType, 'description' | 'gpu_description'> & { specs?: { gpus?: number } }
): Gpu | null {
	const parse = (text: string) => {
		let rest = text.slice(0, 200).trim();
		const counted = /^(\d{1,3})x\s/.exec(rest);
		if (counted) rest = rest.slice(counted[0].length).trim();
		const open = rest.indexOf('(');
		const close = open === -1 ? -1 : rest.indexOf(')', open);
		const model = (open === -1 ? rest : rest.slice(0, open)).trim();
		const inside = close === -1 ? '' : rest.slice(open + 1, close);
		const vram = /^\s*(\d{1,4}(?:\.\d{1,2})?)\s*GB\b/i.exec(inside);
		return {
			count: counted ? Number(counted[1]) : null,
			model,
			vramGb: vram ? Number(vram[1]) : null
		};
	};
	const fromGpu = parse(type.gpu_description ?? '');
	const fromDescription = parse(type.description ?? '');
	const count = type.specs?.gpus || fromDescription.count || 0;
	const model = fromGpu.model || fromDescription.model;
	if (count <= 0 || !model) return null;
	const vramGb = fromGpu.vramGb ?? fromDescription.vramGb;
	return {
		model: OTHER_MAKERS.test(model) ? model : `NVIDIA ${model}`,
		count,
		vramGb: vramGb && vramGb > 0 ? vramGb : null
	};
}

/** A hostname Lambda accepts: lowercase letters, digits and hyphens, at most 63. */
export function hostName(node: string) {
	// every run of other characters (hyphens included) becomes one hyphen, so trimming is linear
	const trim = (value: string) => {
		const start = value.startsWith('-') ? 1 : 0;
		return value.slice(start, value.endsWith('-') ? -1 : undefined);
	};
	const name = trim(trim(node.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 63));
	return name || 'tramline-node';
}

/**
 * Lambda needs an SSH key on every instance. This one's private half is
 * never kept, so nobody can sign in with it: Tramline needs no SSH.
 */
export function throwawaySshKey() {
	const { publicKey } = generateKeyPairSync('ed25519');
	const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
	const field = (bytes: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(bytes.length);
		return Buffer.concat([length, bytes]);
	};
	const blob = Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)]);
	return `ssh-ed25519 ${blob.toString('base64')} ${SSH_KEY_NAME}`;
}

/** Made by Tramline: tagged at launch, or launched with its throwaway key alone. */
const owned = (instance: Instance) =>
	(instance.tags ?? []).some((tag) => tag.key === TAG && tag.value === 'node') ||
	(instance.ssh_key_names.length === 1 && instance.ssh_key_names[0] === SSH_KEY_NAME);

const STATUS: Record<Instance['status'], ProviderNode['status']> = {
	booting: 'provisioning',
	active: 'running',
	unhealthy: 'error',
	terminating: 'stopped',
	preempted: 'stopped',
	terminated: 'stopped'
};

const toNode = (instance: Instance): ProviderNode => ({
	id: instance.id,
	name: instance.name || instance.id,
	region: instance.region?.name ?? null,
	status: STATUS[instance.status] ?? 'unknown',
	address: instance.ip || null,
	instructions: null
});

/** Lambda's instance IDs are hex; anything else isn't one, and isn't put in a URL. */
const ID = /^[A-Za-z0-9-]{1,64}$/;

/** Whether a rule already lets anyone reach UDP 51820. */
const coversMesh = (rule: FirewallRule) =>
	(rule.protocol === 'udp' || rule.protocol === 'all') &&
	rule.source_network.replace(/\/0$/, '') === '0.0.0.0' &&
	(!rule.port_range || (rule.port_range[0] <= MESH_PORT && MESH_PORT <= rule.port_range[1]));

export function lambdaAdapter(options: ClientOptions = {}) {
	const client = (creds: LambdaCredentials) => new LambdaClient(creds.apiKey, options);

	async function find(api: LambdaClient, id: string) {
		if (!ID.test(id)) throw new AdapterError(`${id} isn't a Lambda instance ID`);
		try {
			return await api.get<Instance>(`instances/${encodeURIComponent(id)}`);
		} catch (error) {
			if (error instanceof LambdaError && error.status === 404) return null;
			throw error;
		}
	}

	/** The account's throwaway SSH key, added the first time. */
	async function ensureSshKey(api: LambdaClient) {
		const has = async () =>
			(await api.get<{ name: string }[]>('ssh-keys')).some((key) => key.name === SSH_KEY_NAME);
		if (await has()) return;
		try {
			await api.call('POST', 'ssh-keys', { name: SSH_KEY_NAME, public_key: throwawaySshKey() });
		} catch (error) {
			// another create may have added it meanwhile
			if (!(await has())) throw error;
		}
	}

	/**
	 * Adds the mesh rule to the account's firewall rules, unless one already
	 * covers it. Lambda only replaces the whole list, so it's read and written
	 * back with every rule it had. Returns false when the region has no firewall.
	 */
	async function ensureMeshRule(api: LambdaClient, region: string) {
		if (NO_FIREWALL.has(region)) return false;
		const forbidden = (error: unknown) =>
			error instanceof LambdaError && error.status === 403
				? new AdapterError(
						`The API key can’t change firewall rules, so the mesh port can’t be opened. Turn off “Open the mesh port” in the account, or allow UDP ${MESH_PORT} yourself under Firewall in the Lambda Cloud dashboard.`
					)
				: error;
		let rules: FirewallRule[];
		try {
			rules = await api.get<FirewallRule[]>('firewall-rules');
		} catch (error) {
			throw forbidden(error);
		}
		if (!Array.isArray(rules)) throw new AdapterError('Lambda returned no firewall rules');
		if (rules.some(coversMesh)) return true;
		try {
			await api.call('PUT', 'firewall-rules', { data: [...rules, MESH_RULE] });
		} catch (error) {
			throw forbidden(error);
		}
		return true;
	}

	const adapter = defineAdapter({
		meta: {
			id: 'lambda',
			name: 'Lambda',
			icon: 'cpu',
			description: 'On-demand GPU instances on Lambda Cloud'
		},
		credentials,
		capabilities: {
			spot: false,
			arch: ['amd64', 'arm64'],
			autoProvision: true,
			gpus: true,
			inventory: true,
			// the firewall is one list for the whole account, so TCP 80 and 443 can't be opened to one machine
			edgePorts: false
		},

		async validate(creds) {
			const api = client(creds);
			await api.get('instance-types');
			await api.get('ssh-keys');
			if (creds.openMeshPort) {
				await api.get('firewall-rules').catch((error: unknown) => {
					if (error instanceof LambdaError && error.status === 403) {
						throw new AdapterError(
							`The API key can’t read firewall rules, so the mesh port can’t be opened. Turn off “Open the mesh port”, or use a key that can.`
						);
					}
					throw error;
				});
			}
		},

		async listRegions(creds): Promise<Region[]> {
			const regions = await client(creds).get<LambdaRegion[]>('regions');
			return regions
				.map((r) => ({ id: r.name, name: r.description ? `${r.name} (${r.description})` : r.name }))
				.sort((a, b) => a.id.localeCompare(b.id));
		},

		async listOffers(creds, region): Promise<Offer[]> {
			const api = client(creds);
			const regions = await api.get<LambdaRegion[]>('regions');
			if (!regions.some((r) => r.name === region)) {
				throw new AdapterError(`There is no region called ${region}`);
			}
			const types =
				await api.get<
					Record<
						string,
						{ instance_type: InstanceType; regions_with_capacity_available: LambdaRegion[] }
					>
				>('instance-types');
			return (
				Object.values(types)
					// Lambda only offers what it has room for right now
					.filter((t) => t.regions_with_capacity_available.some((r) => r.name === region))
					.map((t) => t.instance_type)
					.filter((t) => t.specs.vcpus > 0 && t.specs.memory_gib > 0)
					.sort(
						(a, b) =>
							a.price_cents_per_hour - b.price_cents_per_hour || a.name.localeCompare(b.name)
					)
					.map((t) => ({
						id: t.name,
						region,
						name: t.name,
						vcpus: t.specs.vcpus,
						memoryMb: t.specs.memory_gib * 1024,
						diskGb: t.specs.storage_gib > 0 ? t.specs.storage_gib : null,
						arch: t.architecture === 'arm64' ? ('arm64' as const) : ('amd64' as const),
						gpu: parseGpu(t),
						hourly: t.price_cents_per_hour / 100,
						spotHourly: null,
						// Lambda's API doesn't say
						egressPerGb: null
					}))
			);
		},

		async createNode(creds, spec) {
			const api = client(creds);
			const name = spec.name.slice(0, 64);
			const existing = await api.get<Instance[]>('instances');
			if (existing.some((i) => owned(i) && i.name === name && i.status !== 'terminated')) {
				throw new AdapterError(`The Lambda account already has a Tramline instance called ${name}`);
			}
			await ensureSshKey(api);
			const meshOpen = creds.openMeshPort ? await ensureMeshRule(api, spec.region) : false;
			const userData = cloudInit({
				url: spec.install.url,
				token: spec.install.token,
				// only offered as the mesh endpoint when the mesh port is open to it
				publicAddress: meshOpen ? LOCAL_PUBLIC_ADDRESS : undefined
			});
			const launched = await api.call<{ instance_ids: string[] }>(
				'POST',
				'instance-operations/launch',
				{
					region_name: spec.region,
					instance_type_name: spec.offer,
					ssh_key_names: [SSH_KEY_NAME],
					name,
					hostname: hostName(spec.name),
					user_data: userData,
					tags: [{ key: TAG, value: 'node' }]
				}
			);
			const [id, ...extra] = launched?.instance_ids ?? [];
			// one was asked for; anything more would be billed without a node
			if (extra.length) {
				await api
					.call('POST', 'instance-operations/terminate', { instance_ids: extra })
					.catch(() => {});
			}
			if (!id) throw new AdapterError('Lambda launched nothing, and said no more');
			return {
				id,
				name,
				region: spec.region,
				status: 'provisioning' as const,
				address: null,
				instructions: null
			};
		},

		async getNode(creds, id) {
			const instance = await find(client(creds), id);
			if (!instance || !owned(instance) || instance.status === 'terminated') return null;
			return toNode(instance);
		},

		async listNodes(creds) {
			const instances = await client(creds).get<Instance[]>('instances');
			return instances
				.filter((i) => owned(i) && i.status !== 'terminated')
				.map(toNode)
				.sort((a, b) => a.id.localeCompare(b.id));
		},

		async destroyNode(creds, id) {
			const api = client(creds);
			const instance = await find(api, id);
			if (!instance || instance.status === 'terminated') return;
			if (!owned(instance)) {
				throw new AdapterError(
					`${instance.name || instance.id} wasn't created by Tramline, so it was left alone`
				);
			}
			if (instance.status === 'terminating') return;
			try {
				await api.call('POST', 'instance-operations/terminate', { instance_ids: [instance.id] });
			} catch (error) {
				if (error instanceof LambdaError && error.status === 404) return;
				throw error;
			}
		}
	});
	return adapter;
}

export const lambda = lambdaAdapter();
