import {
	AdapterError,
	cloudInit,
	defineAdapter,
	type Offer,
	type ProviderNode,
	type Region
} from '@tramline/adapter-sdk';
import { generateKeyPairSync } from 'node:crypto';
import { z } from 'zod';
import { AzureClient, AzureError, type ClientOptions } from './client';

/**
 * Azure VMs: one per node, in one resource group, from an Ubuntu image
 * whose cloud-init reads the VM's `customData` (which, unlike `userData`,
 * the metadata service never hands back, so a container on the node can't
 * read the join token from it). Each VM gets a static public address that is
 * created first, so the node offers it as its mesh endpoint from the start.
 *
 * Every resource carries the `tramline` tag and a name derived from the VM's
 * (`<name>-ip`, `<name>-nic`, `<name>-disk`); the adapter only ever deletes
 * tagged ones. Each region gets a network and a security group that opens
 * the mesh port (UDP 51820). An edge node's NIC joins the region's
 * application security group `tramline-edge-<region>`, which a rule in that
 * security group opens TCP 80 and 443 to. See docs/adapters/azure.md for the roles.
 */

export const TAG = 'tramline';
export const MESH_PORT = 51820;
/** The ports an edge node serves public domains on. */
export const EDGE_PORTS = ['80', '443'];
export const DEFAULT_IMAGE = 'Canonical:ubuntu-24_04-lts:server:latest';
const COMPUTE_API = 'api-version=2024-07-01';
const NETWORK_API = 'api-version=2024-05-01';
const RESOURCES_API = 'api-version=2021-04-01';
const SUBSCRIPTION_API = 'api-version=2022-12-01';
/** The network each region's nodes join; nodes reach each other over the mesh, not this. */
const ADDRESS_SPACE = '10.73.0.0/16';
const SUBNET = '10.73.0.0/24';

const uuid = (title: string, description: string) =>
	z
		.string()
		.trim()
		.regex(/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i, 'That isn’t an ID like 0000…-…')
		.meta({ title, description });

const credentials = z.object({
	tenantId: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9.-]{1,253}$/, 'Use the Directory (tenant) ID')
		.meta({
			title: 'Directory (tenant) ID',
			description: 'On the app registration’s overview page'
		}),
	clientId: uuid('Application (client) ID', 'On the app registration’s overview page'),
	clientSecret: z.string().trim().min(1).meta({
		title: 'Client secret',
		description:
			'The Value of a secret under Certificates & secrets (not its Secret ID). Tramline keeps it encrypted.',
		secret: true
	}),
	subscriptionId: uuid(
		'Subscription ID',
		'The subscription new VMs are billed to. The app needs Contributor on it, or on the resource group.'
	),
	resourceGroup: z
		.string()
		.trim()
		.regex(/^[-\w.()]{0,89}[-\w()]$/, 'Letters, digits, - _ . ( ), not ending in a dot')
		.default('tramline')
		.meta({
			title: 'Resource group',
			description: 'Where Tramline puts its VMs. It’s created if it doesn’t exist.'
		}),
	image: z
		.string()
		.trim()
		.regex(/^[^:\s]+:[^:\s]+:[^:\s]+:[^:\s]+$/, 'Use publisher:offer:sku:version')
		.default(DEFAULT_IMAGE)
		.meta({ description: 'A marketplace image with cloud-init, as publisher:offer:sku:version' }),
	// Azure's Ubuntu images need at least 30 GB
	diskGb: z.coerce.number().int().min(30).max(4095).default(30).meta({ title: 'Disk size (GB)' }),
	openMeshPort: z
		.boolean()
		.default(true)
		.meta({
			title: 'Open the mesh port',
			description: `Lets other nodes reach these VMs on UDP ${MESH_PORT}, in the security group Tramline creates.`
		})
});

export type AzureCredentials = z.infer<typeof credentials>;

/**
 * General-purpose x86 sizes worth offering, up to 16 vCPUs: B (burstable),
 * D and E (v4 to v6) and F (v2). Arm sizes have a `p`. GPU sizes come with 7d.
 * Standard_B1s is in the free tier for a new account's first year.
 */
const SIZE = /^Standard_([BDEF])(\d+)([a-z]*)(_v\d)?$/;
const MAX_VCPUS = 16;

export function offeredSize(name: string) {
	const match = SIZE.exec(name);
	if (!match) return false;
	const [, family, , letters, version] = match;
	if (letters!.includes('p')) return false;
	if (family === 'B') return !version || version === '_v2';
	if (family === 'F') return version === '_v2';
	return version === '_v4' || version === '_v5' || version === '_v6';
}

/** Lowercase letters, digits and hyphens, starting with a letter; short enough for `-disk`. */
export function vmName(node: string) {
	// every run of other characters (hyphens included) becomes one hyphen, so trimming is linear
	const trim = (value: string) => {
		const start = value.startsWith('-') ? 1 : 0;
		return value.slice(start, value.endsWith('-') ? -1 : undefined);
	};
	const name = trim(node.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
	return trim((/^[a-z]/.test(name) ? name : `tl-${name}`).slice(0, 50));
}

/**
 * Azure needs an SSH key for a Linux VM without a password. This one's
 * private half is never kept, so nobody can sign in: Tramline needs no SSH.
 */
function throwawaySshKey() {
	const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const jwk = publicKey.export({ format: 'jwk' });
	const field = (bytes: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(bytes.length);
		return Buffer.concat([length, bytes]);
	};
	const mpint = (value: string) => {
		const bytes = Buffer.from(value, 'base64url');
		return field(bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
	};
	const blob = Buffer.concat([field(Buffer.from('ssh-rsa')), mpint(jwk.e!), mpint(jwk.n!)]);
	return `ssh-rsa ${blob.toString('base64')} tramline-no-login`;
}

interface Resource {
	name: string;
	location: string;
	tags?: Record<string, string>;
}

interface Vm extends Resource {
	properties: {
		provisioningState?: string;
		instanceView?: { statuses?: { code: string }[] };
	};
}

interface IdRef {
	id: string;
}

interface Nic extends Resource {
	properties: {
		ipConfigurations?: {
			name: string;
			properties: { applicationSecurityGroups?: IdRef[] } & Record<string, unknown>;
		}[];
	} & Record<string, unknown>;
}

interface Nsg extends Resource {
	properties: { securityRules?: { name: string }[] };
}

interface PublicIp extends Resource {
	properties: { ipAddress?: string };
}

interface Page<T> {
	value?: T[];
	nextLink?: string;
}

const tagged = (resource: Resource | null) => resource?.tags?.[TAG] === 'node';

function status(vm: Vm): ProviderNode['status'] {
	const codes = vm.properties.instanceView?.statuses?.map((s) => s.code) ?? [];
	const power = codes.find((code) => code.startsWith('PowerState/'))?.slice('PowerState/'.length);
	const provisioning = vm.properties.provisioningState;
	if (provisioning === 'Creating' || power === 'starting') return 'provisioning';
	if (power === 'running') return 'running';
	if (power && ['stopping', 'stopped', 'deallocating', 'deallocated'].includes(power)) {
		return 'stopped';
	}
	return provisioning === 'Updating' ? 'provisioning' : 'unknown';
}

const toNode = (vm: Vm, address: string | null): ProviderNode => ({
	id: vm.name,
	name: vm.name,
	region: vm.location,
	status: status(vm),
	address,
	instructions: null
});

export function azureAdapter(options: ClientOptions = {}) {
	const client = (creds: AzureCredentials) => new AzureClient(creds, options);

	const group = (creds: AzureCredentials) => `resourceGroups/${creds.resourceGroup}`;
	const paths = (creds: AzureCredentials, name: string) => {
		const base = `${group(creds)}/providers`;
		return {
			vm: `${base}/Microsoft.Compute/virtualMachines/${name}`,
			disk: `${base}/Microsoft.Compute/disks/${name}-disk`,
			nic: `${base}/Microsoft.Network/networkInterfaces/${name}-nic`,
			ip: `${base}/Microsoft.Network/publicIPAddresses/${name}-ip`
		};
	};
	/** A resource ID, as Azure writes them in references. */
	const id = (api: AzureClient, path: string) => `/subscriptions/${api.subscription}/${path}`;

	async function find<T>(api: AzureClient, path: string): Promise<T | null> {
		try {
			return await api.get<T>(path);
		} catch (error) {
			if (error instanceof AzureError && error.status === 404) return null;
			throw error;
		}
	}

	async function addressOf(api: AzureClient, creds: AzureCredentials, name: string) {
		const ip = await find<PublicIp>(api, `${paths(creds, name).ip}?${NETWORK_API}`);
		return ip?.properties.ipAddress ?? null;
	}

	/** The resource group, and the region's security group and network; returns the subnet. */
	async function ensureNetwork(api: AzureClient, creds: AzureCredentials, location: string) {
		const tags = { [TAG]: 'network' };
		const rg = await find<Resource>(api, `${group(creds)}?${RESOURCES_API}`);
		if (!rg) await api.call('PUT', `${group(creds)}?${RESOURCES_API}`, { location, tags });

		const base = `${group(creds)}/providers/Microsoft.Network`;
		const nsg = `${base}/networkSecurityGroups/tramline-${location}`;
		const rule = {
			name: 'tramline-mesh',
			properties: {
				description: 'Tramline: nodes reach each other’s WireGuard mesh',
				protocol: 'Udp',
				sourceAddressPrefix: '*',
				sourcePortRange: '*',
				destinationAddressPrefix: '*',
				destinationPortRange: String(MESH_PORT),
				access: 'Allow',
				direction: 'Inbound',
				priority: 1000
			}
		};
		const existing = await find<{ properties: { securityRules?: { name: string }[] } }>(
			api,
			`${nsg}?${NETWORK_API}`
		);
		if (!existing) {
			await api.run('PUT', `${nsg}?${NETWORK_API}`, {
				location,
				tags,
				properties: { securityRules: creds.openMeshPort ? [rule] : [] }
			});
		} else if (
			creds.openMeshPort &&
			!existing.properties.securityRules?.some((r) => r.name === rule.name)
		) {
			// added on its own, so rules someone else added stay
			await api.run('PUT', `${nsg}/securityRules/${rule.name}?${NETWORK_API}`, {
				properties: rule.properties
			});
		}

		const vnet = `${base}/virtualNetworks/tramline-${location}`;
		const subnet = `${vnet}/subnets/nodes`;
		if (!(await find(api, `${vnet}?${NETWORK_API}`))) {
			await api.run('PUT', `${vnet}?${NETWORK_API}`, {
				location,
				tags,
				properties: {
					addressSpace: { addressPrefixes: [ADDRESS_SPACE] },
					subnets: [
						{
							name: 'nodes',
							properties: { addressPrefix: SUBNET, networkSecurityGroup: { id: id(api, nsg) } }
						}
					]
				}
			});
		}
		return id(api, subnet);
	}

	/**
	 * The region's application security group for edge nodes, and the rule in
	 * its security group that lets the internet reach them on TCP 80 and 443.
	 */
	async function ensureEdgeGroup(api: AzureClient, creds: AzureCredentials, location: string) {
		const base = `${group(creds)}/providers/Microsoft.Network`;
		const asg = `${base}/applicationSecurityGroups/tramline-edge-${location}`;
		const existing = await find<Resource>(api, `${asg}?${NETWORK_API}`);
		if (existing && !existing.tags?.[TAG]) {
			throw new AdapterError(
				`The application security group tramline-edge-${location} wasn't created by Tramline, so it was left alone`
			);
		}
		if (!existing) {
			await api.run('PUT', `${asg}?${NETWORK_API}`, {
				location,
				tags: { [TAG]: 'network' },
				properties: {}
			});
		}
		const nsg = `${base}/networkSecurityGroups/tramline-${location}`;
		const found = await find<Nsg>(api, `${nsg}?${NETWORK_API}`);
		if (!found?.tags?.[TAG]) {
			throw new AdapterError(
				`The security group tramline-${location} is missing or wasn't created by Tramline, so TCP 80 and 443 weren't opened`
			);
		}
		if (!found.properties.securityRules?.some((r) => r.name === 'tramline-edge')) {
			await api.run('PUT', `${nsg}/securityRules/tramline-edge?${NETWORK_API}`, {
				properties: {
					description: 'Tramline: edge nodes serve public domains',
					protocol: 'Tcp',
					sourceAddressPrefix: '*',
					sourcePortRange: '*',
					destinationApplicationSecurityGroups: [{ id: id(api, asg) }],
					destinationPortRanges: EDGE_PORTS,
					access: 'Allow',
					direction: 'Inbound',
					priority: 1010
				}
			});
		}
		return id(api, asg);
	}

	/** Deletes what Tramline made for a VM, in the order Azure allows; skips anything untagged. */
	async function removeAll(api: AzureClient, creds: AzureCredentials, name: string) {
		const { vm, nic, ip, disk } = paths(creds, name);
		for (const [path, api_] of [
			[vm, COMPUTE_API],
			[nic, NETWORK_API],
			[ip, NETWORK_API],
			[disk, COMPUTE_API]
		] as const) {
			const found = await find<Resource>(api, `${path}?${api_}`);
			if (!found || !tagged(found)) continue;
			try {
				await api.run('DELETE', `${path}?${api_}`);
			} catch (error) {
				if (!(error instanceof AzureError && error.status === 404)) throw error;
			}
		}
	}

	async function* pages<T>(api: AzureClient, path: string) {
		let next: string | undefined = path;
		while (next) {
			const page: Page<T> = await api.get<Page<T>>(next);
			yield* page.value ?? [];
			next = page.nextLink;
		}
	}

	const adapter = defineAdapter({
		meta: {
			id: 'azure',
			name: 'Microsoft Azure',
			icon: 'cloud',
			description: 'Azure VMs in your subscription'
		},
		credentials,
		capabilities: {
			spot: false,
			arch: ['amd64'],
			autoProvision: true,
			gpus: false,
			inventory: true,
			edgePorts: true
		},

		async validate(creds) {
			const api = client(creds);
			const subscription = await api.get<{ state?: string; displayName?: string }>(
				`?${SUBSCRIPTION_API}`
			);
			if (subscription.state && subscription.state !== 'Enabled') {
				throw new AdapterError(
					`Subscription ${subscription.displayName ?? api.subscription} is ${subscription.state.toLowerCase()}, so it can’t create VMs`
				);
			}
			for (const namespace of ['Microsoft.Compute', 'Microsoft.Network']) {
				const provider = await api.get<{ registrationState?: string }>(
					`providers/${namespace}?${RESOURCES_API}`
				);
				if (provider.registrationState !== 'Registered') {
					throw new AdapterError(
						`The subscription hasn’t registered ${namespace}. Register it under Subscription → Resource providers, then try again.`
					);
				}
			}
			// a missing group is fine (it's created); one the app can't read isn't
			await find(api, `${group(creds)}?${RESOURCES_API}`);
		},

		async listRegions(creds): Promise<Region[]> {
			const regions: Region[] = [];
			for await (const location of pages<{
				name: string;
				displayName: string;
				metadata?: { regionType?: string };
			}>(client(creds), `locations?${SUBSCRIPTION_API}`)) {
				if (location.metadata?.regionType !== 'Physical') continue;
				regions.push({ id: location.name, name: `${location.name} (${location.displayName})` });
			}
			return regions.sort((a, b) => a.id.localeCompare(b.id));
		},

		async listOffers(creds, region): Promise<Offer[]> {
			const sizes: { name: string; numberOfCores: number; memoryInMB: number }[] = [];
			try {
				for await (const size of pages<(typeof sizes)[number]>(
					client(creds),
					`providers/Microsoft.Compute/locations/${encodeURIComponent(region)}/vmSizes?${COMPUTE_API}`
				)) {
					sizes.push(size);
				}
			} catch (error) {
				if (error instanceof AzureError && (error.status === 404 || error.status === 400)) {
					throw new AdapterError(`There is no region called ${region}`);
				}
				throw error;
			}
			return sizes
				.filter((s) => offeredSize(s.name) && s.numberOfCores <= MAX_VCPUS)
				.sort(
					(a, b) =>
						a.numberOfCores - b.numberOfCores ||
						a.memoryInMB - b.memoryInMB ||
						a.name.localeCompare(b.name)
				)
				.map((s) => ({
					id: s.name,
					region,
					name: s.name,
					vcpus: s.numberOfCores,
					memoryMb: s.memoryInMB,
					diskGb: creds.diskGb,
					arch: 'amd64',
					gpu: null,
					// prices come from the Azure Retail Prices API with Phase 8
					hourly: null,
					spotHourly: null,
					egressPerGb: null
				}));
		},

		async createNode(creds, spec) {
			const api = client(creds);
			const name = vmName(spec.name);
			const location = spec.region;
			const path = paths(creds, name);
			if (await find(api, `${path.vm}?${COMPUTE_API}`)) {
				throw new AdapterError(
					`Resource group ${creds.resourceGroup} already has a VM called ${name}`
				);
			}
			const subnet = await ensureNetwork(api, creds, location);
			const tags = { [TAG]: 'node' };
			const [publisher, offer, sku, version] = creds.image.split(':');
			try {
				await api.run('PUT', `${path.ip}?${NETWORK_API}`, {
					location,
					tags,
					sku: { name: 'Standard' },
					properties: { publicIPAllocationMethod: 'Static', publicIPAddressVersion: 'IPv4' }
				});
				const address = await addressOf(api, creds, name);
				await api.run('PUT', `${path.nic}?${NETWORK_API}`, {
					location,
					tags,
					properties: {
						ipConfigurations: [
							{
								name: 'ipconfig',
								properties: {
									subnet: { id: subnet },
									privateIPAllocationMethod: 'Dynamic',
									publicIPAddress: { id: id(api, path.ip) }
								}
							}
						]
					}
				});
				const userData = cloudInit({
					url: spec.install.url,
					token: spec.install.token,
					// the address is known before the VM boots, so no metadata lookup
					publicAddress:
						address && /^\d{1,3}(\.\d{1,3}){3}$/.test(address) ? `echo ${address}` : undefined
				});
				await api.run('PUT', `${path.vm}?${COMPUTE_API}`, {
					location,
					tags,
					properties: {
						hardwareProfile: { vmSize: spec.offer },
						storageProfile: {
							imageReference: { publisher, offer, sku, version },
							osDisk: {
								name: `${name}-disk`,
								createOption: 'FromImage',
								deleteOption: 'Delete',
								diskSizeGB: creds.diskGb,
								managedDisk: { storageAccountType: 'StandardSSD_LRS' }
							}
						},
						osProfile: {
							computerName: name,
							adminUsername: 'tramline',
							customData: Buffer.from(userData).toString('base64'),
							linuxConfiguration: {
								disablePasswordAuthentication: true,
								ssh: {
									publicKeys: [
										{ path: '/home/tramline/.ssh/authorized_keys', keyData: throwawaySshKey() }
									]
								}
							}
						},
						networkProfile: {
							networkInterfaces: [
								{ id: id(api, path.nic), properties: { primary: true, deleteOption: 'Delete' } }
							]
						},
						securityProfile: {
							securityType: 'TrustedLaunch',
							uefiSettings: { secureBootEnabled: true, vTpmEnabled: true }
						}
					}
				});
				// the OS disk doesn't get the VM's tags, and only tagged things are cleaned up
				await api.call('PATCH', `${path.disk}?${COMPUTE_API}`, { tags }).catch(() => {});
				return {
					id: name,
					name,
					region: location,
					status: 'provisioning' as const,
					address,
					instructions: null
				};
			} catch (error) {
				// nothing half-made is left behind, or billed
				await removeAll(api, creds, name).catch(() => {});
				throw error;
			}
		},

		async getNode(creds, nodeId) {
			const api = client(creds);
			const vm = await find<Vm>(
				api,
				`${paths(creds, vmName(nodeId)).vm}?$expand=instanceView&${COMPUTE_API}`
			);
			if (!vm || !tagged(vm)) return null;
			return toNode(vm, await addressOf(api, creds, vm.name));
		},

		async listNodes(creds) {
			const api = client(creds);
			const base = `${group(creds)}/providers`;
			const vms: Vm[] = [];
			const addresses = new Map<string, string>();
			try {
				for await (const vm of pages<Vm>(
					api,
					`${base}/Microsoft.Compute/virtualMachines?$expand=instanceView&${COMPUTE_API}`
				)) {
					if (tagged(vm)) vms.push(vm);
				}
				for await (const ip of pages<PublicIp>(
					api,
					`${base}/Microsoft.Network/publicIPAddresses?${NETWORK_API}`
				)) {
					if (ip.properties.ipAddress) addresses.set(ip.name, ip.properties.ipAddress);
				}
			} catch (error) {
				// no resource group yet means no machines yet
				if (error instanceof AzureError && error.code === 'ResourceGroupNotFound') return [];
				throw error;
			}
			return vms
				.map((vm) => toNode(vm, addresses.get(`${vm.name}-ip`) ?? null))
				.sort((a, b) => a.id.localeCompare(b.id));
		},

		async destroyNode(creds, nodeId) {
			const api = client(creds);
			const name = vmName(nodeId);
			const vm = await find<Vm>(api, `${paths(creds, name).vm}?${COMPUTE_API}`);
			if (vm && !tagged(vm)) {
				throw new AdapterError(`${vm.name} wasn't created by Tramline, so it was left alone`);
			}
			// also clears what a failed or half-finished create left
			await removeAll(api, creds, name);
		},

		async setEdge(creds, nodeId, open) {
			const api = client(creds);
			const name = vmName(nodeId);
			const path = paths(creds, name);
			const vm = await find<Vm>(api, `${path.vm}?${COMPUTE_API}`);
			const nic = vm && (await find<Nic>(api, `${path.nic}?${NETWORK_API}`));
			if (!vm || !nic) {
				// a machine that's gone has nothing open
				if (open) throw new AdapterError(`There is no VM ${name}`);
				return;
			}
			if (!tagged(vm) || !tagged(nic)) {
				throw new AdapterError(`${vm.name} wasn't created by Tramline, so it was left alone`);
			}
			const edgeGroup = open
				? await ensureEdgeGroup(api, creds, vm.location)
				: id(
						api,
						`${group(creds)}/providers/Microsoft.Network/applicationSecurityGroups/tramline-edge-${vm.location}`
					);
			const same = (ref: IdRef) => ref.id.toLowerCase() === edgeGroup.toLowerCase();
			const configs = nic.properties.ipConfigurations ?? [];
			if (
				configs.every((c) => (c.properties.applicationSecurityGroups ?? []).some(same) === open)
			) {
				return;
			}
			await api.run('PUT', `${path.nic}?${NETWORK_API}`, {
				location: nic.location,
				tags: nic.tags,
				properties: {
					...nic.properties,
					ipConfigurations: configs.map((config) => {
						const others = (config.properties.applicationSecurityGroups ?? []).filter(
							(ref) => !same(ref)
						);
						return {
							...config,
							properties: {
								...config.properties,
								applicationSecurityGroups: open ? [...others, { id: edgeGroup }] : others
							}
						};
					})
				}
			});
		}
	});
	return adapter;
}

export const azure = azureAdapter();
