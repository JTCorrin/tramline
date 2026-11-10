import { conformance, type NodeSpec } from '@tramline/adapter-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { API } from './client';
import { RATES_URL } from './currency';
import { hetznerAdapter, serverName, type HetznerCredentials } from './index';

/**
 * A fake Hetzner Cloud API: enough of servers, server types, images,
 * locations, Primary IPs, firewalls, SSH keys and actions. Lists come three
 * to a page, so paging is exercised, and every action reports "running"
 * once before it finishes, so waiting is too. Deleting a server deletes its
 * Primary IPs that have auto_delete, as Hetzner does.
 */

const TOKEN = 'a'.repeat(64);
const PAGE = 3;

const creds = (overrides: Partial<HetznerCredentials> = {}): HetznerCredentials => ({
	token: TOKEN,
	image: 'ubuntu-24.04',
	...overrides
});

type Labels = Record<string, string>;

interface FakeServer {
	id: number;
	name: string;
	status: string;
	labels: Labels;
	location: { name: string };
	server_type: { name: string };
	image: { id: number };
	public_net: { ipv4: { id: number; ip: string } | null; firewalls: { id: number }[] };
	body?: Record<string, unknown>;
}
interface FakeIp {
	id: number;
	name: string;
	ip: string;
	labels: Labels;
	location: string;
	auto_delete: boolean;
	assignee_id: number | null;
}
interface FakeFirewall {
	id: number;
	name: string;
	labels: Labels;
	rules: Record<string, unknown>[];
}
interface FakeKey {
	id: number;
	name: string;
	public_key: string;
	labels: Labels;
}

let servers: Map<number, FakeServer>;
let ips: Map<number, FakeIp>;
let firewalls: Map<number, FakeFirewall>;
let keys: Map<number, FakeKey>;
let actions: Map<
	number,
	{ polls: number; error?: { code: string; message: string }; done?: () => void }
>;
let requests: string[];
let readOnly: boolean;
let unavailable: Set<string>;
let failing: Set<string>;
/** The account's currency, as `GET /pricing` gives it; and whether the ECB's rates can be had. */
let currency: string;
let ratesDown: boolean;
let seq: number;

const LOCATIONS = [
	{ id: 1, name: 'fsn1', city: 'Falkenstein', country: 'DE' },
	{ id: 2, name: 'nbg1', city: 'Nuremberg', country: 'DE' },
	{ id: 3, name: 'hel1', city: 'Helsinki', country: 'FI' },
	{ id: 4, name: 'ash', city: 'Ashburn, VA', country: 'US' },
	{ id: 6, name: 'sin', city: 'Singapore', country: 'SG' }
];

const here = (names: string[], extra: Record<string, Record<string, unknown>> = {}) =>
	names.map((name) => ({
		id: LOCATIONS.find((l) => l.name === name)!.id,
		name,
		deprecation: null,
		recommended: false,
		available: true,
		...extra[name]
	}));
const priced = (names: string[], net: string) =>
	names.map((location) => ({
		location,
		price_hourly: { net, gross: (Number(net) * 1.19).toFixed(4) },
		price_monthly: { net: (Number(net) * 730).toFixed(4), gross: '0' }
	}));
const EU = ['fsn1', 'nbg1', 'hel1'];
const type = (
	id: number,
	name: string,
	cores: number,
	memory: number,
	disk: number,
	architecture: string,
	locations: ReturnType<typeof here>,
	net = '0.0080',
	extra: Record<string, unknown> = {}
) => ({
	id,
	name,
	description: name.toUpperCase(),
	cores,
	memory,
	disk,
	architecture,
	cpu_type: 'shared',
	storage_type: 'local',
	prices: priced(
		locations.map((l) => l.name),
		net
	),
	locations,
	...extra
});

const SERVER_TYPES = [
	type(101, 'cx53', 16, 32, 320, 'x86', here(EU), '0.0290'),
	type(102, 'cx23', 2, 4, 40, 'x86', here(EU), '0.0059'),
	type(103, 'cax11', 2, 4, 40, 'arm', here(['fsn1', 'nbg1', 'hel1']), '0.0062'),
	type(104, 'ccx63', 48, 192, 960, 'x86', here(EU)),
	// deprecated here, still sold in Ashburn
	type(
		105,
		'cpx11',
		2,
		2,
		40,
		'x86',
		here([...EU, 'ash'], {
			fsn1: {
				deprecation: {
					announced: '2025-01-01T00:00:00Z',
					unavailable_after: '2026-01-01T00:00:00Z'
				}
			}
		})
	),
	type(106, 'cpx22', 2, 4, 80, 'x86', here([...EU, 'ash', 'sin']), '0.0110'),
	// temporarily sold out
	type(107, 'cpx32', 4, 8, 160, 'x86', here(EU, { fsn1: { available: false } })),
	// the older field
	type(108, 'cx11', 1, 2, 20, 'x86', here(EU), '0.0050', { deprecated: true }),
	type(109, 'cx22', 2, 4, 40, 'x86', here(EU), '0.0059'),
	type(110, 'cpx12', 1, 0.5, 20, 'x86', here(EU), '0.0040')
];

const IMAGES = [
	{ id: 161547269, name: 'ubuntu-24.04', type: 'system', status: 'available', architecture: 'x86' },
	{ id: 161547270, name: 'ubuntu-24.04', type: 'system', status: 'available', architecture: 'arm' },
	{ id: 45557056, name: 'debian-12', type: 'system', status: 'available', architecture: 'x86' }
];

function reset() {
	servers = new Map();
	ips = new Map();
	firewalls = new Map();
	keys = new Map();
	actions = new Map();
	requests = [];
	currency = 'EUR';
	ratesDown = false;
	readOnly = false;
	unavailable = new Set();
	failing = new Set();
	seq = 1000;
	// someone else's server in the same project
	servers.set(1, {
		id: 1,
		name: 'theirs',
		status: 'running',
		labels: { env: 'prod' },
		location: { name: 'fsn1' },
		server_type: { name: 'cx23' },
		image: { id: 161547269 },
		public_net: { ipv4: { id: 2, ip: '203.0.113.9' }, firewalls: [] }
	});
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const apiError = (status: number, code: string, message: string) =>
	json({ error: { code, message, details: {} } }, status);

function action(command: string, done?: () => void, error?: { code: string; message: string }) {
	const id = ++seq;
	actions.set(id, { polls: 0, error, done });
	return { id, command, status: 'running', progress: 0, error: null };
}

function page<T>(url: URL, key: string, all: T[]) {
	const number = Number(url.searchParams.get('page') ?? 1);
	expect(url.searchParams.get('per_page') ?? '50').toBe('50');
	const items = all.slice((number - 1) * PAGE, number * PAGE);
	const next = number * PAGE < all.length ? number + 1 : null;
	return json({ [key]: items, meta: { pagination: { page: number, next_page: next } } });
}

/** Hetzner's label selectors, as far as the adapter uses them: `k=v`. */
function selects(selector: string | null, labels: Labels) {
	if (!selector) return true;
	const [key, value] = selector.split('=');
	return labels[key!] === value;
}

const byName = <T extends { name: string }>(url: URL, all: Iterable<T>) => {
	const name = url.searchParams.get('name');
	return [...all].filter((item) => name === null || item.name === name);
};

async function handle(url: URL, init: RequestInit): Promise<Response> {
	const method = init.method ?? 'GET';
	expect(url.href.startsWith(API)).toBe(true);
	const path = url.pathname.replace(/^\/v1\//, '');
	requests.push(`${method} ${path}`);
	if (new Headers(init.headers).get('authorization') !== `Bearer ${TOKEN}`) {
		return apiError(401, 'unauthorized', 'unable to authenticate');
	}
	if (readOnly && method !== 'GET') {
		return apiError(403, 'forbidden', 'insufficient permissions for this request');
	}
	const body = init.body ? JSON.parse(String(init.body)) : null;
	let m: RegExpMatchArray | null;

	if (path === 'pricing') return json({ pricing: { currency, vat_rate: '19.00' } });
	if (path === 'locations') return page(url, 'locations', byName(url, LOCATIONS));
	if (path === 'server_types') return page(url, 'server_types', byName(url, SERVER_TYPES));
	if (path === 'images') {
		expect(url.searchParams.get('type')).toBe('system');
		return json({
			images: byName(url, IMAGES).filter(
				(i) => i.architecture === url.searchParams.get('architecture')
			),
			meta: { pagination: { page: 1, next_page: null } }
		});
	}
	if ((m = path.match(/^actions\/(\d+)$/))) {
		const id = Number(m[1]);
		const found = actions.get(id)!;
		found.polls++;
		if (found.polls < 2) return json({ action: { id, status: 'running', error: null } });
		found.done?.();
		found.done = undefined;
		return json({
			action: found.error
				? { id, status: 'error', error: found.error }
				: { id, status: 'success', error: null }
		});
	}

	if (path === 'ssh_keys') {
		if (method === 'GET') return json({ ssh_keys: byName(url, keys.values()) });
		if ([...keys.values()].some((k) => k.name === body.name)) {
			return apiError(409, 'uniqueness_error', 'SSH key with the same name already exists');
		}
		const key = { id: ++seq, ...body };
		keys.set(key.id, key);
		return json({ ssh_key: key }, 201);
	}

	if (path === 'firewalls') {
		if (method === 'GET') return json({ firewalls: byName(url, firewalls.values()) });
		if ([...firewalls.values()].some((f) => f.name === body.name)) {
			return apiError(409, 'uniqueness_error', 'name is already used');
		}
		const firewall = { id: ++seq, name: body.name, labels: body.labels ?? {}, rules: body.rules };
		firewalls.set(firewall.id, firewall);
		return json({ firewall, actions: [] }, 201);
	}
	if ((m = path.match(/^firewalls\/(\d+)\/actions\/(\w+)$/))) {
		const firewall = firewalls.get(Number(m[1]))!;
		if (m[2] === 'set_rules') {
			firewall.rules = body.rules;
			return json({ actions: [action('set_firewall_rules')] }, 201);
		}
		const id = body[m[2] === 'apply_to_resources' ? 'apply_to' : 'remove_from'][0].server.id;
		const server = servers.get(id);
		if (!server) return apiError(404, 'firewall_resource_not_found', 'server not found');
		const has = server.public_net.firewalls.some((f) => f.id === firewall.id);
		if (m[2] === 'apply_to_resources') {
			if (has) return apiError(422, 'firewall_already_applied', 'already applied');
			return json(
				{
					actions: [
						action('apply_firewall', () => server.public_net.firewalls.push({ id: firewall.id }))
					]
				},
				201
			);
		}
		return json(
			{
				actions: [
					action('remove_firewall', () => {
						server.public_net.firewalls = server.public_net.firewalls.filter(
							(f) => f.id !== firewall.id
						);
					})
				]
			},
			201
		);
	}

	if (path === 'primary_ips') {
		if (method === 'GET') return json({ primary_ips: byName(url, ips.values()) });
		expect(body).toMatchObject({ type: 'ipv4', assignee_type: 'server' });
		if ([...ips.values()].some((ip) => ip.name === body.name)) {
			return apiError(409, 'uniqueness_error', 'name is already used');
		}
		const id = ++seq;
		const ip: FakeIp = {
			id,
			name: body.name,
			ip: `198.51.100.${id % 250}`,
			labels: body.labels ?? {},
			location: body.location,
			auto_delete: body.auto_delete ?? false,
			assignee_id: null
		};
		ips.set(id, ip);
		return json({ primary_ip: ip, action: null }, 201);
	}
	if ((m = path.match(/^primary_ips\/(\d+)$/))) {
		const ip = ips.get(Number(m[1]));
		if (!ip) return apiError(404, 'not_found', 'Primary IP not found');
		if (method === 'GET') return json({ primary_ip: ip });
		if (ip.assignee_id) return apiError(422, 'must_be_unassigned', 'still assigned');
		ips.delete(ip.id);
		return new Response(null, { status: 204 });
	}

	if (path === 'servers' && method === 'GET') {
		return page(
			url,
			'servers',
			byName(url, servers.values()).filter((s) =>
				selects(url.searchParams.get('label_selector'), s.labels)
			)
		);
	}
	if (path === 'servers') {
		if ([...servers.values()].some((s) => s.name === body.name)) {
			return apiError(409, 'uniqueness_error', 'server name is already used');
		}
		const serverType = SERVER_TYPES.find((t) => t.name === body.server_type)!;
		const image = IMAGES.find((i) => String(i.id) === body.image);
		expect(image?.architecture).toBe(serverType.architecture);
		if (unavailable.has(body.server_type)) {
			return apiError(412, 'resource_unavailable', 'server type is unavailable');
		}
		const ip = ips.get(body.public_net.ipv4)!;
		expect(ip.location).toBe(body.location);
		const server: FakeServer = {
			id: ++seq,
			name: body.name,
			status: 'initializing',
			labels: body.labels,
			location: { name: body.location },
			server_type: { name: body.server_type },
			image: { id: image!.id },
			public_net: {
				ipv4: { id: ip.id, ip: ip.ip },
				firewalls: body.firewalls.map((f: { firewall: number }) => ({ id: f.firewall }))
			},
			body
		};
		ip.assignee_id = server.id;
		servers.set(server.id, server);
		const error = failing.has(body.server_type)
			? { code: 'action_failed', message: 'the server could not be created' }
			: undefined;
		return json(
			{
				server,
				action: action('create_server', () => (server.status = 'running'), error),
				next_actions: [],
				root_password: body.ssh_keys?.length ? null : 'hunter2'
			},
			201
		);
	}
	if ((m = path.match(/^servers\/(\d+)$/))) {
		const server = servers.get(Number(m[1]));
		if (!server) return apiError(404, 'not_found', 'server not found');
		if (method === 'GET') return json({ server });
		if (method === 'DELETE') {
			servers.delete(server.id);
			for (const ip of ips.values()) {
				if (ip.assignee_id !== server.id) continue;
				if (ip.auto_delete) ips.delete(ip.id);
				else ip.assignee_id = null;
			}
			return json({ action: action('delete_server') });
		}
	}
	return apiError(405, 'method_not_allowed', `unexpected ${method} ${path}`);
}

// a dollar is worth less than a euro: 1.1 to 1, and 160 yen to the euro
const RATES = `<gesmes:Envelope><Cube><Cube time='2026-11-10'>
	<Cube currency='USD' rate='1.1000'/><Cube currency='JPY' rate='160.00'/>
</Cube></Cube></gesmes:Envelope>`;

const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
	if (String(input) === RATES_URL) {
		return ratesDown ? new Response('down', { status: 503 }) : new Response(RATES);
	}
	return handle(new URL(String(input)), init);
}) as typeof fetch;

const adapter = hetznerAdapter({ fetch: fetcher, pollMs: 1 });

const spec = (overrides: Partial<NodeSpec> = {}): NodeSpec => ({
	name: 'hetzner-node',
	region: 'fsn1',
	offer: 'cx23',
	install: {
		url: 'https://tramline.example.com',
		token: 'tljoin_abc',
		command: 'curl … | sudo sh'
	},
	userData: '#cloud-config',
	seedUrl: 'https://tramline.example.com/api/agent/v1/seed/x/',
	...overrides
});

const firewall = (name: string) => [...firewalls.values()].find((f) => f.name === name);
const writes = (from: number) => requests.slice(from).filter((r) => !r.startsWith('GET'));

beforeEach(reset);

describe('Hetzner adapter', () => {
	it('passes the conformance suite', async () => {
		const steps = await conformance(adapter, {
			credentials: creds(),
			invalidCredentials: creds({ token: 'wrong' }),
			region: 'fsn1',
			offer: 'cx23',
			pollMs: 1
		});
		expect(steps).toContain('no orphans');
		// only someone else's server, the firewalls and the SSH key are left
		expect([...servers.keys()]).toEqual([1]);
		expect([...ips.values()]).toEqual([]);
		expect([...firewalls.values()].map((f) => f.name).sort()).toEqual([
			'tramline-edge',
			'tramline-mesh'
		]);
		expect([...keys.values()].map((k) => k.name)).toEqual(['tramline-no-login']);
	});

	it('checks the token is there, and fills in the image', () => {
		const schema = adapter.credentials;
		expect(schema.safeParse(creds({ token: '  ' })).success).toBe(false);
		expect(schema.safeParse(creds({ image: 'Ubuntu 24.04' })).success).toBe(false);
		expect(schema.parse({ token: ` ${TOKEN} ` })).toEqual({ token: TOKEN, image: 'ubuntu-24.04' });
	});

	it('explains a wrong token and a firewall name that is taken', async () => {
		await expect(adapter.validate(creds({ token: 'nope' }))).rejects.toThrow(
			/rejected the API token/
		);
		await adapter.validate(creds());
		firewalls.set(5, { id: 5, name: 'tramline-mesh', labels: {}, rules: [] });
		await expect(adapter.validate(creds())).rejects.toThrow(/that Tramline didn't create/);
		await expect(adapter.createNode(creds(), spec())).rejects.toThrow(
			/firewall tramline-mesh wasn't created by Tramline/
		);
	});

	it('lists locations over every page', async () => {
		expect(await adapter.listRegions(creds())).toEqual([
			{ id: 'ash', name: 'ash (Ashburn, VA)' },
			{ id: 'fsn1', name: 'fsn1 (Falkenstein)' },
			{ id: 'hel1', name: 'hel1 (Helsinki)' },
			{ id: 'nbg1', name: 'nbg1 (Nuremberg)' },
			{ id: 'sin', name: 'sin (Singapore)' }
		]);
	});

	it('offers the location’s current sizes up to 16 vCPUs, x86 and Arm, with net hourly prices in dollars', async () => {
		const offers = await adapter.listOffers(creds(), 'fsn1');
		expect(offers.map((o) => o.id)).toEqual(['cpx12', 'cpx22', 'cx22', 'cx23', 'cax11', 'cx53']);
		expect(offers.find((o) => o.id === 'cx23')).toEqual({
			id: 'cx23',
			region: 'fsn1',
			name: 'cx23',
			vcpus: 2,
			memoryMb: 4096,
			diskGb: 40,
			arch: 'amd64',
			gpu: null,
			// €0.0059 at $1.10 a euro
			hourly: 0.00649,
			spotHourly: null,
			egressPerGb: null
		});
		expect(offers.find((o) => o.id === 'cax11')).toMatchObject({ arch: 'arm64', hourly: 0.00682 });
		expect(offers[0]).toMatchObject({ memoryMb: 512 });

		// deprecated in fsn1 only; a location only gets the sizes sold there
		expect((await adapter.listOffers(creds(), 'ash')).map((o) => o.id)).toEqual(['cpx11', 'cpx22']);
		expect((await adapter.listOffers(creds(), 'sin')).map((o) => o.id)).toEqual(['cpx22']);
		await expect(adapter.listOffers(creds(), 'moon')).rejects.toThrow(/no region called moon/);
	});

	it('leaves prices out rather than passing euros off as dollars', async () => {
		const price = async (a = hetznerAdapter({ fetch: fetcher, pollMs: 1 })) =>
			(await a.listOffers(creds(), 'fsn1')).find((o) => o.id === 'cx23')?.hourly;
		// an account billed in dollars needs no rate
		currency = 'USD';
		ratesDown = true;
		expect(await price()).toBe(0.0059);
		// no rate: no price, and the sizes are still listed
		currency = 'EUR';
		expect(await price()).toBeNull();
		ratesDown = false;
		currency = 'JPY';
		expect(await price()).toBeCloseTo((0.0059 * 1.1) / 160, 6);
		// a currency the ECB doesn't list
		currency = 'XYZ';
		expect(await price()).toBeNull();
	});

	it('creates a labelled server with its address in cloud-init, behind the mesh firewall, with no password', async () => {
		const node = await adapter.createNode(creds(), spec());
		const server = [...servers.values()].find((s) => s.name === 'hetzner-node')!;
		const ip = [...ips.values()][0]!;
		expect(node).toEqual({
			id: String(server.id),
			name: 'hetzner-node',
			region: 'fsn1',
			status: 'provisioning',
			address: ip.ip,
			instructions: null
		});
		// the address comes first, and goes with the server
		expect(ip).toMatchObject({
			name: 'hetzner-node-ipv4',
			location: 'fsn1',
			auto_delete: true,
			labels: { tramline: 'node' },
			assignee_id: server.id
		});

		const body = server.body as Record<string, unknown> & { user_data: string };
		expect(body).toMatchObject({
			server_type: 'cx23',
			image: '161547269',
			location: 'fsn1',
			labels: { tramline: 'node' },
			ssh_keys: ['tramline-no-login'],
			public_net: { enable_ipv4: true, enable_ipv6: false, ipv4: ip.id }
		});
		expect(body.user_data).toMatch(/^#cloud-config/);
		expect(body.user_data).toContain("--token 'tljoin_abc'");
		expect(body.user_data).toContain(`ADDRESS=$(echo ${ip.ip} || true)`);

		const mesh = firewall('tramline-mesh')!;
		expect(body.firewalls).toEqual([{ firewall: mesh.id }]);
		expect(mesh.labels).toEqual({ tramline: 'network' });
		expect(mesh.rules).toEqual([
			expect.objectContaining({
				direction: 'in',
				protocol: 'udp',
				port: '51820',
				source_ips: ['0.0.0.0/0', '::/0']
			})
		]);

		const [key] = [...keys.values()];
		expect(key!.labels).toEqual({ tramline: 'key' });
		expect(key!.public_key).toMatch(
			/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* tramline-no-login$/
		);
		expect(Buffer.from(key!.public_key.split(' ')[1]!, 'base64')).toHaveLength(51);

		expect(await adapter.getNode(creds(), node.id)).toMatchObject({
			status: 'running',
			region: 'fsn1',
			address: ip.ip
		});

		// the next server reuses the firewall and the key
		const before = requests.length;
		await adapter.createNode(creds(), spec({ name: 'arm', offer: 'cax11', region: 'nbg1' }));
		expect(writes(before)).toEqual(['POST primary_ips', 'POST servers']);
		const arm = [...servers.values()].find((s) => s.name === 'arm')!;
		expect(arm.image.id).toBe(161547270);
	});

	it('adds the mesh rule to its own firewall when it’s missing, keeping other rules', async () => {
		firewalls.set(5, {
			id: 5,
			name: 'tramline-mesh',
			labels: { tramline: 'network' },
			rules: [{ direction: 'in', protocol: 'tcp', port: '22', source_ips: ['192.0.2.1/32'] }]
		});
		await adapter.createNode(creds(), spec());
		expect(firewall('tramline-mesh')!.rules.map((r) => `${r.protocol}/${r.port}`)).toEqual([
			'tcp/22',
			'udp/51820'
		]);
	});

	it('removes what it made when Hetzner can’t create the server', async () => {
		unavailable.add('cx23');
		await expect(adapter.createNode(creds(), spec())).rejects.toThrow(
			/isn’t available in this location.*Try another size or location/
		);
		expect([...ips.values()]).toEqual([]);

		failing.add('cx22');
		await expect(adapter.createNode(creds(), spec({ offer: 'cx22' }))).rejects.toThrow(
			/could not be created/
		);
		expect([...servers.keys()]).toEqual([1]);
		expect([...ips.values()]).toEqual([]);

		await expect(adapter.createNode(creds(), spec({ offer: 'cx99' }))).rejects.toThrow(
			/no size called cx99/
		);
		await expect(adapter.createNode(creds({ image: 'plan9' }), spec())).rejects.toThrow(
			/no x86 system image called plan9/
		);
	});

	it('clears an address a failed create left, but not someone else’s', async () => {
		ips.set(7, {
			id: 7,
			name: 'hetzner-node-ipv4',
			ip: '198.51.100.7',
			labels: { tramline: 'node' },
			location: 'fsn1',
			auto_delete: true,
			assignee_id: null
		});
		await adapter.createNode(creds(), spec());
		expect(ips.has(7)).toBe(false);

		ips.set(8, { ...ips.get([...ips.keys()][0]!)!, id: 8, name: 'b-ipv4', labels: {} });
		await expect(adapter.createNode(creds(), spec({ name: 'b' }))).rejects.toThrow(
			/already has a Primary IP called b-ipv4/
		);
	});

	it('says when the token is read-only', async () => {
		readOnly = true;
		await expect(adapter.createNode(creds(), spec())).rejects.toThrow(/Read & Write/);
	});

	it('explains limits, rate limits and an unreachable API', async () => {
		const answering = (status: number, code: string, message: string) =>
			hetznerAdapter({
				fetch: (async () => apiError(status, code, message)) as unknown as typeof fetch
			});
		await expect(
			answering(403, 'resource_limit_exceeded', 'server limit reached').createNode(creds(), spec())
		).rejects.toThrow(/reached a Hetzner Cloud limit: server limit reached.*smaller size/);
		await expect(
			answering(429, 'rate_limit_exceeded', 'slow down').validate(creds())
		).rejects.toThrow(/rate limit was reached/);
		await expect(answering(500, 'server_error', 'oops').listRegions(creds())).rejects.toThrow(
			'Hetzner Cloud: oops'
		);
		const offline = hetznerAdapter({
			fetch: (async () => {
				throw new TypeError('fetch failed');
			}) as unknown as typeof fetch
		});
		await expect(offline.validate(creds())).rejects.toThrow(
			/Couldn’t reach Hetzner Cloud: fetch failed/
		);
	});

	it('uses the firewall another create made at the same time', async () => {
		const racing = hetznerAdapter({
			pollMs: 1,
			fetch: (async (input: string | URL, init: RequestInit = {}) => {
				const url = new URL(String(input));
				if (url.pathname === '/v1/firewalls' && init.method === 'POST') {
					// the other create's firewall lands first
					await handle(url, init);
				}
				return handle(url, init);
			}) as typeof fetch
		});
		await racing.createNode(creds(), spec());
		expect([...firewalls.values()].filter((f) => f.name === 'tramline-mesh')).toHaveLength(1);
	});

	it('won’t reuse a name, and only lists and destroys servers it created', async () => {
		const first = await adapter.createNode(creds(), spec());
		await expect(adapter.createNode(creds(), spec())).rejects.toThrow(
			/already has a server called hetzner-node/
		);
		for (const name of ['b', 'c', 'd']) await adapter.createNode(creds(), spec({ name }));
		// four servers: two pages
		const listed = await adapter.listNodes(creds());
		expect(listed.map((n) => n.name)).toEqual(['hetzner-node', 'b', 'c', 'd']);
		expect(listed[0]).toMatchObject({ id: first.id, address: first.address });

		expect(await adapter.getNode(creds(), '1')).toBeNull();
		await expect(adapter.destroyNode(creds(), '1')).rejects.toThrow(
			/theirs wasn't created by Tramline/
		);
		expect(servers.has(1)).toBe(true);
		await expect(adapter.getNode(creds(), 'fsn1/theirs')).rejects.toThrow(/isn't a Hetzner/);

		await adapter.destroyNode(creds(), first.id);
		expect(await adapter.getNode(creds(), first.id)).toBeNull();
		await adapter.destroyNode(creds(), first.id);
	});

	it('opens TCP 80 and 443 to an edge server only, through its own firewall', async () => {
		const node = await adapter.createNode(creds(), spec());
		const other = await adapter.createNode(creds(), spec({ name: 'other' }));
		const applied = (id: string) =>
			servers.get(Number(id))!.public_net.firewalls.map((f) => firewalls.get(f.id)!.name);

		await adapter.setEdge!(creds(), node.id, true);
		expect(applied(node.id)).toEqual(['tramline-mesh', 'tramline-edge']);
		expect(applied(other.id)).toEqual(['tramline-mesh']);
		const edge = firewall('tramline-edge')!;
		expect(edge.labels).toEqual({ tramline: 'network' });
		expect(edge.rules).toEqual([
			expect.objectContaining({ direction: 'in', protocol: 'tcp', port: '80' }),
			expect.objectContaining({ direction: 'in', protocol: 'tcp', port: '443' })
		]);

		// opening again changes nothing
		let before = requests.length;
		await adapter.setEdge!(creds(), node.id, true);
		expect(writes(before)).toEqual([]);

		await adapter.setEdge!(creds(), node.id, false);
		expect(applied(node.id)).toEqual(['tramline-mesh']);
		before = requests.length;
		await adapter.setEdge!(creds(), node.id, false);
		expect(writes(before)).toEqual([]);

		// a server that's gone has nothing to close, and can't be opened
		await adapter.setEdge!(creds(), '424242', false);
		await expect(adapter.setEdge!(creds(), '424242', true)).rejects.toThrow(
			/There is no server 424242/
		);
	});

	it('closes nothing when there is no edge firewall yet', async () => {
		const node = await adapter.createNode(creds(), spec());
		const before = requests.length;
		await adapter.setEdge!(creds(), node.id, false);
		expect(writes(before)).toEqual([]);
	});

	it('only touches servers and firewalls it created', async () => {
		await expect(adapter.setEdge!(creds(), '1', true)).rejects.toThrow(/left alone/);
		const node = await adapter.createNode(creds(), spec());
		firewalls.set(9, { id: 9, name: 'tramline-edge', labels: {}, rules: [] });
		await expect(adapter.setEdge!(creds(), node.id, true)).rejects.toThrow(
			/firewall tramline-edge wasn't created by Tramline/
		);
		keys.set(10, { id: 10, name: 'tramline-no-login', public_key: 'ssh-ed25519 x', labels: {} });
		keys.delete([...keys.keys()][0]!);
		await expect(adapter.createNode(creds(), spec({ name: 'b' }))).rejects.toThrow(
			/SSH key tramline-no-login wasn't created by Tramline/
		);
	});

	it('names servers the way Hetzner allows', () => {
		expect(serverName('hetzner-node')).toBe('hetzner-node');
		expect(serverName('GPU_Box.1')).toBe('gpu-box-1');
		expect(serverName('1st')).toBe('tl-1st');
		expect(serverName('a'.repeat(70))).toHaveLength(63);
		const started = performance.now();
		expect(serverName(`a${'-'.repeat(100_000)}b`)).toBe('a-b');
		expect(performance.now() - started).toBeLessThan(100);
	});
});

// a real project: TRAMLINE_HETZNER_TOKEN, and optionally _REGION and _OFFER
describe.skipIf(!process.env.TRAMLINE_HETZNER_TOKEN)('Hetzner adapter against Hetzner', () => {
	it('passes the conformance suite', { timeout: 20 * 60_000 }, async () => {
		const steps = await conformance(hetznerAdapter(), {
			credentials: creds({ token: process.env.TRAMLINE_HETZNER_TOKEN! }),
			region: process.env.TRAMLINE_HETZNER_REGION ?? 'fsn1',
			offer: process.env.TRAMLINE_HETZNER_OFFER ?? 'cx23',
			pollMs: 5_000
		});
		expect(steps).toContain('no orphans');
	});
});
