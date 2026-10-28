import {
	AdapterError,
	defineAdapter,
	type Offer,
	type ProviderNode,
	type Region
} from '@tramline/adapter-sdk';
import { z } from 'zod';
import { ProxmoxClient } from './client';

/**
 * Proxmox VE: VMs cloned from a cloud-init template. The template needs
 * cloud-init (any cloud image has it) and a network that hands out an address
 * (DHCP, or the template's own ipconfig). Proxmox's API can't upload user
 * data, so each VM is pointed at its seed on Tramline through its SMBIOS
 * serial (`ds=nocloud;s=…`), and fetches it on first boot.
 *
 * Every VM it creates is tagged `tramline`, and it only ever destroys VMs
 * with that tag. See docs/adapters/proxmox.md for the token's permissions.
 */

export const TAG = 'tramline';

const credentials = z.object({
	url: z
		.url({ protocol: /^https$/ })
		.meta({ title: 'Proxmox URL', placeholder: 'https://pve.lan:8006' }),
	tokenId: z
		.string()
		.regex(/^[^@\s]+@[^!\s]+![\w.-]+$/, 'Use user@realm!name')
		.meta({
			title: 'API token ID',
			placeholder: 'tramline@pve!tramline'
		}),
	tokenSecret: z.string().min(1).meta({ title: 'API token secret', secret: true }),
	fingerprint: z
		.string()
		.regex(/^([0-9A-Fa-f]{2}:?){31}[0-9A-Fa-f]{2}$/, 'Use the SHA-256 fingerprint, AA:BB:…')
		.optional()
		.meta({
			title: 'Certificate fingerprint',
			description:
				"SHA-256, from the node's System → Certificates. Needed when the certificate is self-signed."
		}),
	template: z.coerce.number().int().positive().meta({
		title: 'Template VM ID',
		description:
			'A cloud-init template, e.g. a Debian or Ubuntu cloud image converted to a template'
	}),
	storage: z
		.string()
		.optional()
		.meta({ description: "Where new VMs' disks go; defaults to the template's storage" }),
	pool: z.string().optional().meta({ description: 'Resource pool to put new VMs in' }),
	monthlyCost: z.coerce.number().nonnegative().default(0).meta({
		title: 'Cost per host (USD a month)',
		description: 'Used to price VMs by their share of a host’s memory; 0 if it’s already paid for'
	})
});

export type ProxmoxCredentials = z.infer<typeof credentials>;

/** VM sizes offered on every host that fits them. Disks keep the template's size. */
export const SIZES = [
	{ id: 'small', name: 'Small', vcpus: 2, memoryMb: 4096 },
	{ id: 'medium', name: 'Medium', vcpus: 4, memoryMb: 8192 },
	{ id: 'large', name: 'Large', vcpus: 8, memoryMb: 16_384 },
	{ id: 'xlarge', name: 'X-Large', vcpus: 16, memoryMb: 32_768 }
] as const;

interface Resource {
	vmid: number;
	name?: string;
	node: string;
	status?: string;
	template?: number;
	tags?: string;
	lock?: string;
	type?: string;
}

const tagged = (vm: Resource) =>
	(vm.tags ?? '')
		.split(/[;,\s]+/)
		.filter(Boolean)
		.includes(TAG);

function toNode(vm: Resource): ProviderNode {
	return {
		id: String(vm.vmid),
		name: vm.name ?? `vm-${vm.vmid}`,
		region: vm.node,
		status: vm.lock
			? 'provisioning'
			: vm.status === 'running'
				? 'running'
				: vm.status === 'stopped'
					? 'stopped'
					: 'unknown',
		address: null,
		instructions: null
	};
}

export interface ProxmoxOptions {
	/** How often to poll Proxmox tasks; tests make it fast. */
	pollMs?: number;
	taskTimeoutMs?: number;
}

export function proxmoxAdapter(options: ProxmoxOptions = {}) {
	const client = (creds: ProxmoxCredentials) => new ProxmoxClient(creds, options);

	const vms = (api: ProxmoxClient) => api.get<Resource[]>('cluster/resources', { type: 'vm' });

	async function find(api: ProxmoxClient, id: string) {
		return (await vms(api)).find((vm) => String(vm.vmid) === id && vm.type !== 'lxc');
	}

	/** Stops a VM if it runs, then deletes it with its disks. */
	async function remove(api: ProxmoxClient, vm: Resource) {
		const path = `nodes/${vm.node}/qemu/${vm.vmid}`;
		if (vm.status === 'running') {
			await api.wait(vm.node, await api.post<string>(`${path}/status/stop`));
		}
		await api.wait(
			vm.node,
			await api.delete<string>(path, { purge: true, 'destroy-unreferenced-disks': true })
		);
	}

	async function template(api: ProxmoxClient, creds: ProxmoxCredentials) {
		const vm = (await vms(api)).find((r) => r.vmid === creds.template);
		if (!vm) throw new AdapterError(`There is no VM ${creds.template} for the token to see`);
		if (!vm.template) throw new AdapterError(`VM ${creds.template} is not a template`);
		return vm;
	}

	const adapter = defineAdapter({
		meta: {
			id: 'proxmox',
			name: 'Proxmox VE',
			icon: 'server',
			description: 'VMs cloned from a cloud-init template on your Proxmox cluster'
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
			await api.get('version');
			await template(api, creds);
		},

		async listRegions(creds): Promise<Region[]> {
			const nodes = await client(creds).get<{ node: string; status: string }[]>('nodes');
			return nodes
				.filter((n) => n.status === 'online')
				.map((n) => ({ id: n.node, name: n.node }))
				.sort((a, b) => a.id.localeCompare(b.id));
		},

		async listOffers(creds, region): Promise<Offer[]> {
			const nodes =
				await client(creds).get<{ node: string; maxcpu?: number; maxmem?: number }[]>('nodes');
			const host = nodes.find((n) => n.node === region);
			if (!host?.maxcpu || !host.maxmem) return [];
			const hostMb = host.maxmem / 1024 / 1024;
			return SIZES.filter((size) => size.vcpus <= host.maxcpu! && size.memoryMb <= hostMb).map(
				(size) => ({
					...size,
					region,
					diskGb: null,
					arch: 'amd64',
					gpu: null,
					hourly:
						Math.round(((creds.monthlyCost / 730) * size.memoryMb * 10_000) / hostMb) / 10_000,
					spotHourly: null,
					egressPerGb: null
				})
			);
		},

		async createNode(creds, spec) {
			const api = client(creds);
			const size = SIZES.find((s) => s.id === spec.offer);
			if (!size) throw new AdapterError(`There is no ${spec.offer} size`);
			const source = await template(api, creds);
			const vmid = Number(await api.get<string>('cluster/nextid'));
			const cloning = await api.post<string>(`nodes/${source.node}/qemu/${creds.template}/clone`, {
				newid: vmid,
				name: spec.name,
				full: true,
				target: spec.region === source.node ? undefined : spec.region,
				storage: creds.storage,
				pool: creds.pool,
				description: `Tramline node ${spec.name}`
			});
			await api.wait(source.node, cloning);
			try {
				const path = `nodes/${spec.region}/qemu/${vmid}`;
				const config = await api.get<{ smbios1?: string }>(`${path}/config`);
				const uuid = config.smbios1?.match(/(?:^|,)uuid=([^,]+)/)?.[1];
				// cloud-init reads `ds=nocloud;s=<url>` from the serial and fetches its user data there
				const serial = Buffer.from(`ds=nocloud;s=${spec.seedUrl}`).toString('base64');
				await api.put(`${path}/config`, {
					cores: size.vcpus,
					memory: size.memoryMb,
					smbios1: [uuid && `uuid=${uuid}`, 'base64=1', `serial=${serial}`]
						.filter(Boolean)
						.join(','),
					tags: TAG,
					agent: 1,
					onboot: 1
				});
				await api.wait(spec.region, await api.post<string>(`${path}/status/start`));
			} catch (error) {
				// a clone that can't be set up and started is no use to anyone. It isn't tagged
				// yet, but it's the one just made, so it goes without the tag check
				const clone = await find(api, String(vmid)).catch(() => undefined);
				if (clone) await remove(api, clone).catch(() => {});
				throw error;
			}
			return {
				id: String(vmid),
				name: spec.name,
				region: spec.region,
				status: 'provisioning',
				address: null,
				instructions: null
			};
		},

		async getNode(creds, id) {
			const vm = await find(client(creds), id);
			return vm && tagged(vm) ? toNode(vm) : null;
		},

		async listNodes(creds) {
			return (await vms(client(creds)))
				.filter((vm) => vm.type !== 'lxc' && !vm.template && tagged(vm))
				.map(toNode);
		},

		async destroyNode(creds, id) {
			const api = client(creds);
			const vm = await find(api, id);
			if (!vm) return;
			if (!tagged(vm) || vm.template) {
				throw new AdapterError(`VM ${id} wasn't created by Tramline, so it was left alone`);
			}
			await remove(api, vm);
		}
	});
	return adapter;
}

export const proxmox = proxmoxAdapter();
