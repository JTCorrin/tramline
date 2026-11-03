import {
	AdapterError,
	cloudInit,
	defineAdapter,
	type Offer,
	type ProviderNode,
	type Region
} from '@tramline/adapter-sdk';
import { z } from 'zod';
import { GcpClient, GoogleError, type ClientOptions, type ServiceAccountKey } from './client';

/**
 * Google Compute Engine: one VM per node, from an Ubuntu image (which runs
 * cloud-init from the `user-data` metadata key). VMs get a public address,
 * no service account of their own, and the `tramline` label and network
 * tag; the adapter only ever deletes VMs with the label. A firewall rule
 * opens the mesh port (UDP 51820) to VMs with the tag.
 *
 * A region is offered as a whole; the VM goes in its first zone that has
 * the machine type and room for it. See docs/adapters/gcp.md for the roles.
 */

export const LABEL = 'tramline';
export const MESH_PORT = 51820;
export const DEFAULT_IMAGE = 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64';
/** The address Google's metadata server gives the VM's first public interface. */
export const METADATA_ADDRESS =
	'curl -fsS -H Metadata-Flavor:Google http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip';

function parseKey(json: string): ServiceAccountKey | null {
	try {
		const key = JSON.parse(json) as Partial<ServiceAccountKey> & { type?: string };
		if (key.type !== 'service_account' || !key.project_id || !key.client_email) return null;
		if (!key.private_key?.includes('PRIVATE KEY')) return null;
		return key as ServiceAccountKey;
	} catch {
		return null;
	}
}

const credentials = z.object({
	serviceAccountKey: z
		.string()
		.refine((json) => parseKey(json) !== null, {
			message: 'Paste the whole JSON key file of a service account'
		})
		.meta({
			title: 'Service account key (JSON)',
			description:
				'From IAM & Admin → Service Accounts → Keys → Add key → JSON. The account needs Compute Instance Admin (v1), and Compute Security Admin to open the mesh port.',
			secret: true,
			multiline: true,
			placeholder: '{ "type": "service_account", … }'
		}),
	project: z.string().optional().meta({
		title: 'Project ID',
		description: 'Defaults to the key’s own project'
	}),
	network: z.string().default('default').meta({ description: 'The VPC network new VMs join' }),
	image: z.string().default(DEFAULT_IMAGE).meta({
		description: 'A boot image or image family with cloud-init, e.g. Ubuntu’s'
	}),
	diskGb: z.coerce.number().int().min(10).max(4096).default(20).meta({ title: 'Disk size (GB)' }),
	openMeshPort: z
		.boolean()
		.default(true)
		.meta({
			title: 'Open the mesh port',
			description: `Adds a firewall rule letting other nodes reach these VMs on UDP ${MESH_PORT}. Needs Compute Security Admin.`
		})
});

export type GcpCredentials = z.infer<typeof credentials>;

/**
 * General-purpose sizes worth offering, up to 16 vCPUs. GPU machines come with 7d.
 * e2-micro is in the free tier in us-central1, us-east1 and us-west1.
 */
const SIZE =
	/^(e2-(micro|small|medium|standard-\d+|highmem-\d+|highcpu-\d+)|(n2|n2d|n4|c3|c4)-standard-\d+)$/;
const MAX_VCPUS = 16;

/** Where each region is, since the API only has its name. */
const PLACES: Record<string, string> = {
	'africa-south1': 'Johannesburg',
	'asia-east1': 'Taiwan',
	'asia-east2': 'Hong Kong',
	'asia-northeast1': 'Tokyo',
	'asia-northeast2': 'Osaka',
	'asia-northeast3': 'Seoul',
	'asia-south1': 'Mumbai',
	'asia-south2': 'Delhi',
	'asia-southeast1': 'Singapore',
	'asia-southeast2': 'Jakarta',
	'australia-southeast1': 'Sydney',
	'australia-southeast2': 'Melbourne',
	'europe-central2': 'Warsaw',
	'europe-north1': 'Finland',
	'europe-southwest1': 'Madrid',
	'europe-west1': 'Belgium',
	'europe-west2': 'London',
	'europe-west3': 'Frankfurt',
	'europe-west4': 'Netherlands',
	'europe-west6': 'Zurich',
	'europe-west8': 'Milan',
	'europe-west9': 'Paris',
	'europe-west10': 'Berlin',
	'europe-west12': 'Turin',
	'me-central1': 'Doha',
	'me-west1': 'Tel Aviv',
	'northamerica-northeast1': 'Montréal',
	'northamerica-northeast2': 'Toronto',
	'southamerica-east1': 'São Paulo',
	'southamerica-west1': 'Santiago',
	'us-central1': 'Iowa',
	'us-east1': 'South Carolina',
	'us-east4': 'Virginia',
	'us-east5': 'Columbus',
	'us-south1': 'Dallas',
	'us-west1': 'Oregon',
	'us-west2': 'Los Angeles',
	'us-west3': 'Salt Lake City',
	'us-west4': 'Las Vegas'
};

interface Instance {
	name: string;
	zone: string;
	status: string;
	labels?: Record<string, string>;
	networkInterfaces?: { accessConfigs?: { natIP?: string }[] }[];
}

interface MachineType {
	name: string;
	guestCpus: number;
	memoryMb: number;
	deprecated?: unknown;
}

const last = (url: string) => url.split('/').pop()!;
const regionOf = (zone: string) => zone.replace(/-[a-z]$/, '');

/** GCE names: lowercase letters, digits and hyphens, starting with a letter, at most 63. */
export function instanceName(node: string) {
	// every run of other characters (hyphens included) becomes one hyphen, so trimming is linear
	const trim = (value: string) => {
		const start = value.startsWith('-') ? 1 : 0;
		return value.slice(start, value.endsWith('-') ? -1 : undefined);
	};
	const name = trim(node.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
	return trim((/^[a-z]/.test(name) ? name : `tl-${name}`).slice(0, 63));
}

function toNode(vm: Instance): ProviderNode {
	const zone = last(vm.zone);
	return {
		id: `${zone}/${vm.name}`,
		name: vm.name,
		region: regionOf(zone),
		status:
			vm.status === 'RUNNING'
				? 'running'
				: ['PROVISIONING', 'STAGING', 'REPAIRING'].includes(vm.status)
					? 'provisioning'
					: ['STOPPING', 'STOPPED', 'SUSPENDING', 'SUSPENDED', 'TERMINATED'].includes(vm.status)
						? 'stopped'
						: 'unknown',
		address: vm.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? null,
		instructions: null
	};
}

/** `zone/name`, as `createNode` returns it. */
function splitId(id: string) {
	const match = id.match(/^([a-z0-9-]+)\/([a-z][a-z0-9-]{0,62})$/);
	if (!match) throw new AdapterError(`${id} isn't a GCP machine ID (zone/name)`);
	return { zone: match[1]!, name: match[2]! };
}

/** Zone-level shortages worth trying the next zone for. */
const SHORTAGES = new Set([
	'ZONE_RESOURCE_POOL_EXHAUSTED',
	'ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS'
]);

export function gcpAdapter(options: ClientOptions = {}) {
	const client = (creds: GcpCredentials) => {
		const key = parseKey(creds.serviceAccountKey);
		if (!key) throw new AdapterError('The service account key isn’t a valid JSON key');
		return new GcpClient({ ...key, project_id: creds.project || key.project_id }, options);
	};

	async function zonesIn(api: GcpClient, region: string) {
		let zones: string[];
		try {
			const found = await api.get<{ zones?: string[] }>(`regions/${encodeURIComponent(region)}`);
			zones = (found.zones ?? []).map(last).sort();
		} catch (error) {
			if (error instanceof GoogleError && error.status === 404) {
				throw new AdapterError(`There is no region called ${region}`);
			}
			throw error;
		}
		if (!zones.length) throw new AdapterError(`There is no usable zone in ${region}`);
		return zones;
	}

	async function find(api: GcpClient, id: string) {
		const { zone, name } = splitId(id);
		try {
			return await api.get<Instance>(`zones/${zone}/instances/${name}`);
		} catch (error) {
			if (error instanceof GoogleError && error.status === 404) return null;
			throw error;
		}
	}

	/** Lets nodes reach each other's mesh port; there is one rule per network. */
	async function ensureFirewall(api: GcpClient, creds: GcpCredentials) {
		const name = `tramline-mesh-${creds.network}`.slice(0, 63);
		try {
			await api.get(`global/firewalls/${name}`);
			return;
		} catch (error) {
			if (!(error instanceof GoogleError && error.status === 404)) throw firewallError(error);
		}
		try {
			await api.wait(
				await api.call('POST', 'global/firewalls', {
					name,
					description: 'Tramline: nodes reach each other’s WireGuard mesh',
					network: `global/networks/${creds.network}`,
					direction: 'INGRESS',
					allowed: [{ IPProtocol: 'udp', ports: [String(MESH_PORT)] }],
					sourceRanges: ['0.0.0.0/0'],
					targetTags: [LABEL]
				})
			);
		} catch (error) {
			if (error instanceof GoogleError && error.reason === 'alreadyExists') return;
			throw firewallError(error);
		}
	}

	const firewallError = (error: unknown) =>
		error instanceof GoogleError && error.status === 403
			? new AdapterError(
					`The service account can’t manage firewall rules, so the mesh port can’t be opened. Give it Compute Security Admin, or turn off “Open the mesh port” and allow UDP ${MESH_PORT} to VMs tagged “${LABEL}” yourself.`
				)
			: error;

	const adapter = defineAdapter({
		meta: {
			id: 'gcp',
			name: 'Google Cloud',
			icon: 'cloud',
			description: 'Compute Engine VMs in your Google Cloud project'
		},
		credentials,
		capabilities: {
			spot: false,
			arch: ['amd64'],
			autoProvision: true,
			gpus: false,
			inventory: true
		},

		async validate(creds) {
			const api = client(creds);
			await api.get(`zones?maxResults=1`);
			await api.get(`global/networks/${creds.network}`).catch((error: unknown) => {
				if (error instanceof GoogleError && error.status === 404) {
					throw new AdapterError(`Project ${api.project} has no network called ${creds.network}`);
				}
				throw error;
			});
			if (creds.openMeshPort) {
				await api.get(`global/firewalls/tramline-mesh-${creds.network}`).catch((error: unknown) => {
					if (error instanceof GoogleError && error.status === 404) return;
					throw firewallError(error);
				});
			}
		},

		async listRegions(creds): Promise<Region[]> {
			const { items = [] } = await client(creds).get<{
				items?: { name: string; status: string }[];
			}>('regions');
			return items
				.filter((r) => r.status === 'UP')
				.map((r) => ({
					id: r.name,
					name: PLACES[r.name] ? `${r.name} (${PLACES[r.name]})` : r.name
				}))
				.sort((a, b) => a.id.localeCompare(b.id));
		},

		async listOffers(creds, region): Promise<Offer[]> {
			const api = client(creds);
			const [zone] = await zonesIn(api, region);
			const { items = [] } = await api.get<{ items?: MachineType[] }>(
				`zones/${zone}/machineTypes?maxResults=500`
			);
			return items
				.filter((m) => SIZE.test(m.name) && !m.deprecated && m.guestCpus <= MAX_VCPUS)
				.sort(
					(a, b) =>
						a.guestCpus - b.guestCpus || a.memoryMb - b.memoryMb || a.name.localeCompare(b.name)
				)
				.map((m) => ({
					id: m.name,
					region,
					name: m.name,
					vcpus: m.guestCpus,
					memoryMb: m.memoryMb,
					diskGb: creds.diskGb,
					arch: 'amd64',
					gpu: null,
					// prices come from the Cloud Billing catalog with Phase 8
					hourly: null,
					spotHourly: null,
					egressPerGb: null
				}));
		},

		async createNode(creds, spec) {
			const api = client(creds);
			const name = instanceName(spec.name);
			if (creds.openMeshPort) await ensureFirewall(api, creds);
			const userData = cloudInit({
				url: spec.install.url,
				token: spec.install.token,
				publicAddress: METADATA_ADDRESS
			});
			let lastError: unknown = null;
			for (const zone of await zonesIn(api, spec.region)) {
				// not every size is in every zone
				const offered = await api
					.get(`zones/${zone}/machineTypes/${encodeURIComponent(spec.offer)}`)
					.then(
						() => true,
						(error: unknown) => {
							if (error instanceof GoogleError && error.status === 404) return false;
							throw error;
						}
					);
				if (!offered) continue;
				const body = {
					name,
					description: `Tramline node ${spec.name}`,
					machineType: `zones/${zone}/machineTypes/${spec.offer}`,
					labels: { [LABEL]: 'node' },
					tags: { items: [LABEL] },
					disks: [
						{
							boot: true,
							autoDelete: true,
							initializeParams: {
								sourceImage: creds.image,
								diskSizeGb: String(creds.diskGb),
								diskType: `zones/${zone}/diskTypes/pd-balanced`
							}
						}
					],
					networkInterfaces: [
						{
							network: `global/networks/${creds.network}`,
							accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }]
						}
					],
					metadata: { items: [{ key: 'user-data', value: userData }] },
					// the VM needs no Google Cloud access of its own
					serviceAccounts: [],
					shieldedInstanceConfig: { enableSecureBoot: true, enableVtpm: true }
				};
				try {
					await api.wait(await api.call('POST', `zones/${zone}/instances`, body));
					return {
						id: `${zone}/${name}`,
						name,
						region: spec.region,
						status: 'provisioning' as const,
						address: null,
						instructions: null
					};
				} catch (error) {
					if (error instanceof GoogleError && error.reason === 'alreadyExists') {
						throw new AdapterError(`Project ${api.project} already has a VM called ${name}`);
					}
					if (!(error instanceof GoogleError && error.reason && SHORTAGES.has(error.reason))) {
						throw error;
					}
					// a VM that failed for lack of room may still have been recorded
					await api.call('DELETE', `zones/${zone}/instances/${name}`).catch(() => {});
					lastError = error;
				}
			}
			if (!lastError) throw new AdapterError(`No zone in ${spec.region} offers ${spec.offer}`);
			throw new AdapterError(
				`No zone in ${spec.region} has room for a ${spec.offer} right now (${lastError instanceof Error ? lastError.message : String(lastError)}). Try another size or region.`
			);
		},

		async getNode(creds, id) {
			const vm = await find(client(creds), id);
			return vm && vm.labels?.[LABEL] ? toNode(vm) : null;
		},

		async listNodes(creds) {
			const api = client(creds);
			const vms: Instance[] = [];
			let page: string | undefined;
			do {
				const res = await api.get<{
					items?: Record<string, { instances?: Instance[] }>;
					nextPageToken?: string;
				}>(
					`aggregated/instances?maxResults=500${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`
				);
				vms.push(...Object.values(res.items ?? {}).flatMap((scope) => scope.instances ?? []));
				page = res.nextPageToken;
			} while (page);
			return vms
				.filter((vm) => vm.labels?.[LABEL])
				.map(toNode)
				.sort((a, b) => a.id.localeCompare(b.id));
		},

		async destroyNode(creds, id) {
			const api = client(creds);
			const vm = await find(api, id);
			if (!vm) return;
			if (!vm.labels?.[LABEL]) {
				throw new AdapterError(`${vm.name} wasn't created by Tramline, so it was left alone`);
			}
			const { zone, name } = splitId(id);
			try {
				await api.wait(await api.call('DELETE', `zones/${zone}/instances/${name}`));
			} catch (error) {
				if (error instanceof GoogleError && error.status === 404) return;
				throw error;
			}
		}
	});
	return adapter;
}

export const gcp = gcpAdapter();
