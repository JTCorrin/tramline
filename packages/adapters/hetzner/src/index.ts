import {
	AdapterError,
	cloudInit,
	defineAdapter,
	type Arch,
	type Offer,
	type ProviderNode,
	type Region
} from '@tramline/adapter-sdk';
import { generateKeyPairSync } from 'node:crypto';
import { z } from 'zod';
import { HetznerClient, HetznerError, type Action, type ClientOptions } from './client';

/**
 * Hetzner Cloud: one server per node, from Ubuntu 24.04 (the x86 or Arm
 * build, to match the size), with cloud-init `user_data`. Each server gets a
 * Primary IPv4 that is created first, so the node offers it as its mesh
 * endpoint from the start; the IP is deleted with the server.
 *
 * Servers and their IPs carry the `tramline=node` label; the adapter only
 * ever lists and deletes labelled ones. Every server gets the firewall
 * `tramline-mesh`, which lets in UDP 51820 and nothing else. An edge node
 * also gets `tramline-edge`, which lets in TCP 80 and 443; Hetzner combines
 * the rules of every firewall on a server. See docs/adapters/hetzner.md.
 */

export const LABEL = 'tramline';
export const MESH_PORT = 51820;
export const MESH_FIREWALL = 'tramline-mesh';
export const EDGE_FIREWALL = 'tramline-edge';
/** The ports an edge node serves public domains on. */
export const EDGE_PORTS = ['80', '443'];
export const SSH_KEY = 'tramline-no-login';
export const DEFAULT_IMAGE = 'ubuntu-24.04';
const ANYWHERE = ['0.0.0.0/0', '::/0'];

const credentials = z.object({
	token: z.string().trim().min(1).meta({
		title: 'API token',
		description:
			'From the project’s Security → API tokens, with Read & Write. Tramline keeps it encrypted.',
		secret: true
	}),
	image: z
		.string()
		.trim()
		.regex(/^[a-z0-9][a-z0-9.-]*$/, 'Use a system image’s name, like ubuntu-24.04')
		.default(DEFAULT_IMAGE)
		.meta({
			description:
				'A system image with cloud-init, by name. Tramline picks its x86 or Arm build to match the size.'
		})
});

export type HetznerCredentials = z.infer<typeof credentials>;

/** Up to 16 vCPUs, like the other clouds' general-purpose sizes. */
const MAX_VCPUS = 16;

const ARCH: Record<string, Arch> = { x86: 'amd64', arm: 'arm64' };

type Labels = Record<string, string>;

interface ServerType {
	id: number;
	name: string;
	cores: number;
	/** GB */
	memory: number;
	/** GB */
	disk: number;
	architecture: string;
	/** Older responses only; `locations[].deprecation` replaced it. */
	deprecated?: boolean;
	prices: { location: string; price_hourly: { net: string; gross: string } }[];
	locations?: { name: string; deprecation: unknown; available?: boolean }[];
}

interface Server {
	id: number;
	name: string;
	status: string;
	labels?: Labels;
	location?: { name: string };
	public_net?: {
		ipv4?: { id?: number; ip: string } | null;
		firewalls?: { id: number; status?: string }[];
	};
}

interface Rule {
	description?: string | null;
	direction: 'in' | 'out';
	protocol: string;
	port?: string | null;
	source_ips?: string[];
	destination_ips?: string[];
}

interface Firewall {
	id: number;
	name: string;
	labels?: Labels;
	rules?: Rule[];
}

interface PrimaryIp {
	id: number;
	ip: string;
	labels?: Labels;
	assignee_id?: number | null;
}

const MESH_RULES: Rule[] = [
	{
		description: 'Tramline: nodes reach each other’s WireGuard mesh',
		direction: 'in',
		protocol: 'udp',
		port: String(MESH_PORT),
		source_ips: ANYWHERE
	}
];

const EDGE_RULES: Rule[] = EDGE_PORTS.map((port) => ({
	description: 'Tramline: edge nodes serve public domains',
	direction: 'in',
	protocol: 'tcp',
	port,
	source_ips: ANYWHERE
}));

const ours = (labels: Labels | undefined, kind: string) => labels?.[LABEL] === kind;

/** Hostnames: lowercase letters, digits and hyphens, starting with a letter, at most 63. */
export function serverName(node: string) {
	// every run of other characters (hyphens included) becomes one hyphen, so trimming is linear
	const trim = (value: string) => {
		const start = value.startsWith('-') ? 1 : 0;
		return value.slice(start, value.endsWith('-') ? -1 : undefined);
	};
	const name = trim(node.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
	return trim((/^[a-z]/.test(name) ? name : `tl-${name}`).slice(0, 63));
}

/**
 * Hetzner generates a root password for a server created without an SSH
 * key. This key's private half is never kept, so nobody can sign in, and
 * there is no password: Tramline needs no SSH.
 */
function throwawaySshKey() {
	const { publicKey } = generateKeyPairSync('ed25519');
	const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
	const field = (bytes: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(bytes.length);
		return Buffer.concat([length, bytes]);
	};
	const blob = Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)]);
	return `ssh-ed25519 ${blob.toString('base64')} ${SSH_KEY}`;
}

function status(server: Server): ProviderNode['status'] {
	if (server.status === 'running') return 'running';
	if (['initializing', 'starting', 'rebuilding', 'migrating'].includes(server.status)) {
		return 'provisioning';
	}
	if (['stopping', 'off', 'deleting'].includes(server.status)) return 'stopped';
	return 'unknown';
}

const toNode = (server: Server): ProviderNode => ({
	id: String(server.id),
	name: server.name,
	region: server.location?.name ?? null,
	status: status(server),
	address: server.public_net?.ipv4?.ip ?? null,
	instructions: null
});

/** Server IDs are numbers; `createNode` returns them as strings. */
function serverId(id: string) {
	if (!/^\d{1,16}$/.test(id)) throw new AdapterError(`${id} isn't a Hetzner Cloud server ID`);
	return id;
}

const sameRule = (a: Rule, b: Rule) =>
	a.direction === b.direction && a.protocol === b.protocol && (a.port ?? null) === (b.port ?? null);

export function hetznerAdapter(options: ClientOptions = {}) {
	const client = (creds: HetznerCredentials) => new HetznerClient(creds.token, options);
	const query = (value: string) => encodeURIComponent(value);

	async function find(api: HetznerClient, id: string) {
		try {
			return (await api.get<{ server: Server }>(`servers/${serverId(id)}`)).server;
		} catch (error) {
			if (error instanceof HetznerError && error.status === 404) return null;
			throw error;
		}
	}

	async function waitAll(api: HetznerClient, actions: Action[] | undefined) {
		for (const action of actions ?? []) await api.wait(action);
	}

	const findFirewall = async (api: HetznerClient, name: string) =>
		(await api.get<{ firewalls: Firewall[] }>(`firewalls?name=${query(name)}`)).firewalls[0] ??
		null;

	/** A firewall Tramline made, with at least these rules; returns its ID. */
	async function ensureFirewall(api: HetznerClient, name: string, rules: Rule[], retry = true) {
		const found = await findFirewall(api, name);
		if (found && !ours(found.labels, 'network')) {
			throw new AdapterError(
				`The firewall ${name} wasn't created by Tramline, so it was left alone. Rename or delete it, then try again.`
			);
		}
		if (found) {
			const missing = rules.filter((rule) => !found.rules?.some((r) => sameRule(r, rule)));
			if (missing.length) {
				// rules someone else added stay
				const result = await api.call<{ actions?: Action[] }>(
					'POST',
					`firewalls/${found.id}/actions/set_rules`,
					{ rules: [...(found.rules ?? []), ...missing] }
				);
				await waitAll(api, result.actions);
			}
			return found.id;
		}
		try {
			const created = await api.call<{ firewall: Firewall; actions?: Action[] }>(
				'POST',
				'firewalls',
				{ name, labels: { [LABEL]: 'network' }, rules }
			);
			await waitAll(api, created.actions);
			return created.firewall.id;
		} catch (error) {
			// another create made it first
			if (retry && error instanceof HetznerError && error.code === 'uniqueness_error') {
				return ensureFirewall(api, name, rules, false);
			}
			throw error;
		}
	}

	/** The project's throwaway SSH key, so Hetzner makes no root password. */
	async function ensureSshKey(api: HetznerClient, retry = true): Promise<void> {
		const { ssh_keys } = await api.get<{ ssh_keys: { id: number; labels?: Labels }[] }>(
			`ssh_keys?name=${SSH_KEY}`
		);
		const found = ssh_keys[0];
		if (found && !ours(found.labels, 'key')) {
			throw new AdapterError(
				`The SSH key ${SSH_KEY} wasn't created by Tramline, so it was left alone. Rename or delete it, then try again.`
			);
		}
		if (found) return;
		try {
			await api.call('POST', 'ssh_keys', {
				name: SSH_KEY,
				public_key: throwawaySshKey(),
				labels: { [LABEL]: 'key' }
			});
		} catch (error) {
			if (retry && error instanceof HetznerError && error.code === 'uniqueness_error') {
				return ensureSshKey(api, false);
			}
			throw error;
		}
	}

	async function imageFor(api: HetznerClient, name: string, architecture: string) {
		const { images } = await api.get<{ images: { id: number }[] }>(
			`images?type=system&status=available&name=${query(name)}&architecture=${query(architecture)}`
		);
		if (!images[0]) {
			throw new AdapterError(`Hetzner Cloud has no ${architecture} system image called ${name}`);
		}
		return images[0].id;
	}

	/** Deletes a Primary IP Tramline made, if it's still there and unused. */
	async function removeIp(api: HetznerClient, id: number) {
		try {
			const { primary_ip } = await api.get<{ primary_ip: PrimaryIp }>(`primary_ips/${id}`);
			if (ours(primary_ip.labels, 'node') && !primary_ip.assignee_id) {
				await api.call('DELETE', `primary_ips/${id}`);
			}
		} catch (error) {
			if (!(error instanceof HetznerError && error.status === 404)) throw error;
		}
	}

	const adapter = defineAdapter({
		meta: {
			id: 'hetzner',
			name: 'Hetzner Cloud',
			icon: 'cloud',
			description: 'Hetzner Cloud servers in your project'
		},
		credentials,
		capabilities: {
			spot: false,
			arch: ['amd64', 'arm64'],
			autoProvision: true,
			gpus: false,
			inventory: true,
			edgePorts: true
		},

		async validate(creds) {
			// a cheap read that the token must be allowed, and that finds a clash early
			const found = await findFirewall(client(creds), MESH_FIREWALL);
			if (found && !ours(found.labels, 'network')) {
				throw new AdapterError(
					`The project already has a firewall called ${MESH_FIREWALL} that Tramline didn't create. Rename or delete it, then try again.`
				);
			}
		},

		async listRegions(creds): Promise<Region[]> {
			const locations = await client(creds).list<{ name: string; city?: string }>(
				'locations',
				'locations'
			);
			return locations
				.map((l) => ({ id: l.name, name: l.city ? `${l.name} (${l.city})` : l.name }))
				.sort((a, b) => a.id.localeCompare(b.id));
		},

		async listOffers(creds, region): Promise<Offer[]> {
			const api = client(creds);
			const { locations } = await api.get<{ locations: unknown[] }>(
				`locations?name=${query(region)}`
			);
			if (!locations.length) throw new AdapterError(`There is no region called ${region}`);
			const types = await api.list<ServerType>('server_types', 'server_types');
			return types
				.filter((t) => {
					const here = t.locations?.find((l) => l.name === region);
					return (
						here &&
						!here.deprecation &&
						here.available !== false &&
						!t.deprecated &&
						ARCH[t.architecture] &&
						t.cores <= MAX_VCPUS
					);
				})
				.sort(
					(a, b) =>
						a.cores - b.cores ||
						a.memory - b.memory ||
						(a.architecture === b.architecture ? 0 : a.architecture === 'x86' ? -1 : 1) ||
						a.name.localeCompare(b.name)
				)
				.map((t) => {
					// net (without VAT), per hour, in the currency of the project owner's
					// account: euros for most, though Offer prices are meant to be dollars
					const price = t.prices.find((p) => p.location === region)?.price_hourly.net;
					const hourly = price === undefined ? NaN : Number(price);
					return {
						id: t.name,
						region,
						name: t.name,
						vcpus: t.cores,
						memoryMb: Math.round(t.memory * 1024),
						diskGb: t.disk,
						arch: ARCH[t.architecture]!,
						gpu: null,
						hourly: Number.isFinite(hourly) && hourly >= 0 ? hourly : null,
						spotHourly: null,
						egressPerGb: null
					};
				});
		},

		async createNode(creds, spec) {
			const api = client(creds);
			const name = serverName(spec.name);
			const location = spec.region;
			const labels = { [LABEL]: 'node' };

			const { servers } = await api.get<{ servers: Server[] }>(`servers?name=${query(name)}`);
			if (servers.length) {
				throw new AdapterError(`The project already has a server called ${name}`);
			}
			const { server_types } = await api.get<{ server_types: ServerType[] }>(
				`server_types?name=${query(spec.offer)}`
			);
			const type = server_types[0];
			if (!type) throw new AdapterError(`Hetzner Cloud has no size called ${spec.offer}`);
			const image = await imageFor(api, creds.image, type.architecture);
			const firewall = await ensureFirewall(api, MESH_FIREWALL, MESH_RULES);
			await ensureSshKey(api);

			// an address a failed create left behind would block the name
			const ipName = `${name}-ipv4`;
			const { primary_ips } = await api.get<{ primary_ips: PrimaryIp[] }>(
				`primary_ips?name=${query(ipName)}`
			);
			if (primary_ips[0]) {
				if (!ours(primary_ips[0].labels, 'node') || primary_ips[0].assignee_id) {
					throw new AdapterError(`The project already has a Primary IP called ${ipName}`);
				}
				await api.call('DELETE', `primary_ips/${primary_ips[0].id}`);
			}

			let ip: PrimaryIp | null = null;
			let server: Server | null = null;
			try {
				const createdIp = await api.call<{ primary_ip: PrimaryIp; action?: Action | null }>(
					'POST',
					'primary_ips',
					{
						name: ipName,
						type: 'ipv4',
						location,
						assignee_type: 'server',
						// deleted with the server
						auto_delete: true,
						labels
					}
				);
				ip = createdIp.primary_ip;
				await api.wait(createdIp.action);
				const userData = cloudInit({
					url: spec.install.url,
					token: spec.install.token,
					// the address is known before the server boots, so no metadata lookup
					publicAddress: /^\d{1,3}(\.\d{1,3}){3}$/.test(ip.ip) ? `echo ${ip.ip}` : undefined
				});
				const created = await api.call<{ server: Server; action: Action }>('POST', 'servers', {
					name,
					server_type: spec.offer,
					// an ID as a string; a name could match both the x86 and the Arm build
					image: String(image),
					location,
					start_after_create: true,
					ssh_keys: [SSH_KEY],
					user_data: userData,
					labels,
					firewalls: [{ firewall }],
					// the mesh and edge use IPv4, and an unused IPv6 address would be one more thing to clean up
					public_net: { enable_ipv4: true, enable_ipv6: false, ipv4: ip.id }
				});
				server = created.server;
				await api.wait(created.action);
				return {
					id: String(server.id),
					name,
					region: location,
					status: 'provisioning' as const,
					address: ip.ip,
					instructions: null
				};
			} catch (error) {
				// nothing half-made is left behind, or billed
				if (server) {
					await api
						.call<{ action?: Action }>('DELETE', `servers/${server.id}`)
						.then((result) => api.wait(result?.action))
						.catch(() => {});
				}
				if (ip) await removeIp(api, ip.id).catch(() => {});
				if (error instanceof HetznerError && error.code === 'uniqueness_error') {
					throw new AdapterError(`The project already has a server called ${name}`);
				}
				throw error;
			}
		},

		async getNode(creds, id) {
			const server = await find(client(creds), id);
			return server && ours(server.labels, 'node') ? toNode(server) : null;
		},

		async listNodes(creds) {
			const servers = await client(creds).list<Server>(
				`servers?label_selector=${query(`${LABEL}=node`)}`,
				'servers'
			);
			return servers
				.filter((s) => ours(s.labels, 'node'))
				.sort((a, b) => a.id - b.id)
				.map(toNode);
		},

		async destroyNode(creds, id) {
			const api = client(creds);
			const server = await find(api, id);
			if (!server) return;
			if (!ours(server.labels, 'node')) {
				throw new AdapterError(`${server.name} wasn't created by Tramline, so it was left alone`);
			}
			try {
				const result = await api.call<{ action?: Action }>('DELETE', `servers/${server.id}`);
				await api.wait(result?.action);
			} catch (error) {
				if (error instanceof HetznerError && error.status === 404) return;
				throw error;
			}
		},

		async setEdge(creds, id, open) {
			const api = client(creds);
			const server = await find(api, id);
			if (!server) {
				// a machine that's gone has nothing open
				if (open) throw new AdapterError(`There is no server ${id}`);
				return;
			}
			if (!ours(server.labels, 'node')) {
				throw new AdapterError(`${server.name} wasn't created by Tramline, so it was left alone`);
			}
			let firewall: number;
			if (open) {
				firewall = await ensureFirewall(api, EDGE_FIREWALL, EDGE_RULES);
			} else {
				const found = await findFirewall(api, EDGE_FIREWALL);
				if (!found) return;
				firewall = found.id;
			}
			const applied = (server.public_net?.firewalls ?? []).some((f) => f.id === firewall);
			if (applied === open) return;
			const resources = [{ type: 'server', server: { id: server.id } }];
			try {
				const result = await api.call<{ actions?: Action[] }>(
					'POST',
					`firewalls/${firewall}/actions/${open ? 'apply_to_resources' : 'remove_from_resources'}`,
					open ? { apply_to: resources } : { remove_from: resources }
				);
				await waitAll(api, result.actions);
			} catch (error) {
				const done = open ? 'firewall_already_applied' : 'firewall_resource_not_found';
				if (error instanceof HetznerError && error.code === done) return;
				throw error;
			}
		}
	});
	return adapter;
}

export const hetzner = hetznerAdapter();
