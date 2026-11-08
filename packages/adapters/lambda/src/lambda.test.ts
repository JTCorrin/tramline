import { conformance, type NodeSpec } from '@tramline/adapter-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { API } from './client';
import {
	hostName,
	lambdaAdapter,
	LOCAL_PUBLIC_ADDRESS,
	parseGpu,
	SSH_KEY_NAME,
	throwawaySshKey,
	type LambdaCredentials
} from './index';

/**
 * A fake Lambda Cloud API, shaped like its OpenAPI spec (1.10.0): `{ data }`
 * on success, `{ error: { code, message } }` on failure, a bearer API key.
 * A terminated instance stays visible as `terminated` once, then is gone,
 * and the first launch is rate-limited once, as Lambda allows one launch
 * every 12 seconds.
 */

const KEY = 'secret_tramline_0123456789abcdef.ABCDEFGHIJ';

const creds = (overrides: Partial<LambdaCredentials> = {}): LambdaCredentials => ({
	apiKey: KEY,
	openMeshPort: true,
	...overrides
});

interface StoredInstance {
	id: string;
	name?: string;
	ip?: string;
	status: string;
	ssh_key_names: string[];
	file_system_names: string[];
	region: { name: string; description: string };
	instance_type: unknown;
	tags?: { key: string; value: string }[];
	user_data?: string;
	hostname?: string;
	polls: number;
}

const REGIONS = [
	{ name: 'us-west-1', description: 'California, USA' },
	{ name: 'us-east-1', description: 'Virginia, USA' },
	{ name: 'us-south-1', description: 'Texas, USA' }
];

const type = (
	name: string,
	description: string,
	gpu_description: string,
	cents: number,
	specs: { vcpus: number; memory_gib: number; storage_gib: number; gpus: number },
	architecture: 'x86_64' | 'arm64' = 'x86_64'
) => ({ name, description, gpu_description, price_cents_per_hour: cents, specs, architecture });

const TYPES = {
	gpu_1x_a10: {
		instance_type: type('gpu_1x_a10', '1x A10 (24 GB PCIe)', 'A10 (24 GB PCIe)', 75, {
			vcpus: 30,
			memory_gib: 200,
			storage_gib: 1400,
			gpus: 1
		}),
		regions_with_capacity_available: [REGIONS[0], REGIONS[2]]
	},
	gpu_8x_h100_sxm5: {
		instance_type: type('gpu_8x_h100_sxm5', '8x H100 (80 GB SXM5)', 'H100 (80 GB SXM5)', 2392, {
			vcpus: 208,
			memory_gib: 1800,
			storage_gib: 24780,
			gpus: 8
		}),
		regions_with_capacity_available: [REGIONS[0]]
	},
	gpu_1x_gh200: {
		instance_type: type(
			'gpu_1x_gh200',
			'1x GH200 (96 GB)',
			'GH200 (96 GB)',
			149,
			{ vcpus: 64, memory_gib: 432, storage_gib: 4096, gpus: 1 },
			'arm64'
		),
		regions_with_capacity_available: [REGIONS[1]]
	},
	gpu_1x_a100: {
		// no capacity anywhere right now
		instance_type: type('gpu_1x_a100', '1x A100 (40 GB PCIe)', 'A100 (40 GB PCIe)', 129, {
			vcpus: 30,
			memory_gib: 200,
			storage_gib: 512,
			gpus: 1
		}),
		regions_with_capacity_available: []
	}
};

let instances: Map<string, StoredInstance>;
let sshKeys: { id: string; name: string; public_key: string }[];
let firewall: unknown[] | null;
let requests: string[];
let limitedLaunch: boolean;
let noCapacity: Set<string>;
let forbidFirewall: boolean;
let seq: number;

function reset() {
	instances = new Map();
	sshKeys = [{ id: 'k-theirs', name: 'my-laptop', public_key: 'ssh-ed25519 AAAA mine' }];
	// the account's own rules, which must survive
	firewall = [
		{
			protocol: 'tcp',
			port_range: [22, 22],
			source_network: '0.0.0.0/0',
			description: 'Allow SSH from anywhere'
		},
		{ protocol: 'icmp', source_network: '0.0.0.0/0', description: 'Ping' },
		{
			protocol: 'tcp',
			port_range: [8888, 8888],
			source_network: '203.0.113.7/32',
			description: 'Jupyter from home'
		}
	];
	requests = [];
	limitedLaunch = true;
	noCapacity = new Set();
	forbidFirewall = false;
	seq = 0;
	// someone else's instance on the same account
	instances.set('theirs0000000000000000000000000', {
		id: 'theirs0000000000000000000000000',
		name: 'training-run',
		ip: '198.51.100.9',
		status: 'active',
		ssh_key_names: ['my-laptop'],
		file_system_names: [],
		region: REGIONS[0]!,
		instance_type: TYPES.gpu_1x_a10.instance_type,
		polls: 0
	});
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	Response.json(body, { status, headers });
const lambdaError = (status: number, code: string, message: string) =>
	json({ error: { code, message } }, status);

const view = (i: StoredInstance) => {
	const { user_data, polls, ...rest } = i;
	void [user_data, polls];
	return rest;
};

/** Terminated instances show as such for one look, then disappear, as Lambda's do. */
function settle() {
	for (const [id, i] of instances) {
		if (i.status === 'terminating') i.status = 'terminated';
		else if (i.status === 'terminated' && ++i.polls > 1) instances.delete(id);
		else if (i.status === 'booting') {
			i.status = 'active';
			i.ip = `192.0.2.${parseInt(id.slice(-2), 16) || 1}`;
		}
	}
}

async function handle(url: URL, init: RequestInit): Promise<Response> {
	const method = init.method ?? 'GET';
	expect(url.href.startsWith(API)).toBe(true);
	const path = url.href.slice(API.length);
	requests.push(`${method} ${path}`);
	if (new Headers(init.headers).get('authorization') !== `Bearer ${KEY}`) {
		return lambdaError(401, 'global/invalid-api-key', 'API key was invalid, expired, or deleted.');
	}
	const body = init.body ? JSON.parse(String(init.body)) : null;

	if (method === 'GET' && path === 'regions') return json({ data: REGIONS });
	if (method === 'GET' && path === 'instance-types') return json({ data: TYPES });
	if (path === 'ssh-keys') {
		if (method === 'GET') return json({ data: sshKeys });
		if (sshKeys.some((k) => k.name === body.name)) {
			return lambdaError(400, 'global/invalid-parameters', 'SSH key name already in use');
		}
		const key = { id: `k${++seq}`, name: body.name, public_key: body.public_key };
		sshKeys.push(key);
		return json({ data: key });
	}
	if (path === 'firewall-rules') {
		if (forbidFirewall) {
			return lambdaError(403, 'global/forbidden', 'You are not authorized to perform this action.');
		}
		if (method === 'GET') return json({ data: firewall });
		expect(Array.isArray(body.data)).toBe(true);
		firewall = body.data;
		return json({ data: firewall });
	}
	if (method === 'GET' && path === 'instances') {
		settle();
		return json({ data: [...instances.values()].map(view), page_token: null });
	}
	let m = path.match(/^instances\/([^/?]+)$/);
	if (m && method === 'GET') {
		settle();
		const found = instances.get(decodeURIComponent(m[1]!));
		if (!found) {
			return lambdaError(404, 'global/object-does-not-exist', 'Specified instance does not exist.');
		}
		return json({ data: view(found) });
	}
	if (method === 'POST' && path === 'instance-operations/launch') {
		if (limitedLaunch) {
			limitedLaunch = false;
			return lambdaError(429, 'global/rate-limited', 'Too many requests.');
		}
		const entry = TYPES[body.instance_type_name as keyof typeof TYPES];
		if (!entry || !REGIONS.some((r) => r.name === body.region_name)) {
			return lambdaError(404, 'global/object-does-not-exist', 'No such instance type or region');
		}
		if (noCapacity.has(body.instance_type_name)) {
			return lambdaError(
				400,
				'instance-operations/launch/insufficient-capacity',
				'Not enough capacity to fulfill launch request.'
			);
		}
		expect(body.ssh_key_names).toHaveLength(1);
		if (!sshKeys.some((k) => k.name === body.ssh_key_names[0])) {
			return lambdaError(404, 'global/object-does-not-exist', 'SSH key not found');
		}
		expect(body.name.length).toBeLessThanOrEqual(64);
		expect(body.hostname).toMatch(/^[a-z0-9][0-9a-z-]{0,62}$/);
		for (const tag of body.tags ?? []) expect(tag.key).toMatch(/^[a-z][a-z0-9-:]+$/);
		const id = `${'0'.repeat(30)}${(++seq).toString(16).padStart(2, '0')}`;
		instances.set(id, {
			id,
			name: body.name,
			status: 'booting',
			ssh_key_names: body.ssh_key_names,
			file_system_names: [],
			region: REGIONS.find((r) => r.name === body.region_name)!,
			instance_type: entry.instance_type,
			tags: body.tags,
			user_data: body.user_data,
			hostname: body.hostname,
			polls: 0
		});
		return json({ data: { instance_ids: [id] } });
	}
	if (method === 'POST' && path === 'instance-operations/terminate') {
		const done = [];
		for (const id of body.instance_ids as string[]) {
			const found = instances.get(id);
			if (!found || found.status === 'terminated') {
				return lambdaError(
					404,
					'global/object-does-not-exist',
					'Specified instance does not exist.'
				);
			}
			found.status = 'terminating';
			done.push(view(found));
		}
		return json({ data: { terminated_instances: done } });
	}
	return lambdaError(404, 'global/not-found', `unexpected ${method} ${path}`);
}

const fetcher = (async (input: string | URL, init: RequestInit = {}) =>
	handle(new URL(String(input)), init)) as typeof fetch;

const adapter = lambdaAdapter({ fetch: fetcher, retryMs: 1 });

const spec = (overrides: Partial<NodeSpec> = {}): NodeSpec => ({
	name: 'gpu-node',
	region: 'us-west-1',
	offer: 'gpu_1x_a10',
	install: {
		url: 'https://tramline.example.com',
		token: 'tljoin_abc',
		command: 'curl … | sudo sh'
	},
	userData: '#cloud-config',
	seedUrl: 'https://tramline.example.com/api/agent/v1/seed/x/',
	...overrides
});

const mine = () =>
	[...instances.values()].filter((i) => i.id !== 'theirs0000000000000000000000000');

beforeEach(reset);

describe('Lambda adapter', () => {
	it('passes the conformance suite', async () => {
		const steps = await conformance(adapter, {
			credentials: creds(),
			invalidCredentials: creds({ apiKey: 'secret_wrong' }),
			region: 'us-west-1',
			pollMs: 1
		});
		expect(steps).toContain('no orphans');
		// the cheapest size with room in the region
		expect(requests.some((r) => r === 'POST instance-operations/launch')).toBe(true);
		expect(mine()).toEqual([]);
		expect(instances.has('theirs0000000000000000000000000')).toBe(true);
	});

	it('checks the key before calling Lambda, and explains a wrong one', async () => {
		expect(adapter.credentials.safeParse(creds({ apiKey: 'two words' })).success).toBe(false);
		expect(adapter.credentials.parse({ apiKey: ` ${KEY} ` })).toEqual({
			apiKey: KEY,
			openMeshPort: true
		});
		await expect(adapter.validate(creds({ apiKey: 'secret_nope' }))).rejects.toThrow(
			/Lambda refused the API key.*API keys in the Lambda Cloud dashboard/
		);
		forbidFirewall = true;
		await expect(adapter.validate(creds())).rejects.toThrow(/can’t read firewall rules/);
		await adapter.validate(creds({ openMeshPort: false }));
	});

	it('lists regions with where they are', async () => {
		expect(await adapter.listRegions(creds())).toEqual([
			{ id: 'us-east-1', name: 'us-east-1 (Virginia, USA)' },
			{ id: 'us-south-1', name: 'us-south-1 (Texas, USA)' },
			{ id: 'us-west-1', name: 'us-west-1 (California, USA)' }
		]);
	});

	it('offers the sizes with room in the region, cheapest first, with GPUs and prices', async () => {
		const offers = await adapter.listOffers(creds(), 'us-west-1');
		expect(offers).toEqual([
			{
				id: 'gpu_1x_a10',
				region: 'us-west-1',
				name: 'gpu_1x_a10',
				vcpus: 30,
				memoryMb: 204_800,
				diskGb: 1400,
				arch: 'amd64',
				gpu: { model: 'NVIDIA A10', count: 1, vramGb: 24 },
				hourly: 0.75,
				spotHourly: null,
				egressPerGb: null
			},
			expect.objectContaining({
				id: 'gpu_8x_h100_sxm5',
				gpu: { model: 'NVIDIA H100', count: 8, vramGb: 80 },
				hourly: 23.92
			})
		]);
		// every offer has a price, so the cost confirmations work
		expect(offers.every((o) => o.hourly !== null && o.hourly > 0)).toBe(true);
		// GH200s are Arm
		expect(await adapter.listOffers(creds(), 'us-east-1')).toEqual([
			expect.objectContaining({
				id: 'gpu_1x_gh200',
				arch: 'arm64',
				gpu: { model: 'NVIDIA GH200', count: 1, vramGb: 96 }
			})
		]);
		await expect(adapter.listOffers(creds(), 'moon-1')).rejects.toThrow(/no region called moon-1/);
	});

	it('reads the GPUs from Lambda’s descriptions', () => {
		const gpu = (description: string, gpu_description: string, gpus?: number) =>
			parseGpu({ description, gpu_description, specs: gpus === undefined ? undefined : { gpus } });
		// the examples in Lambda's API reference
		expect(gpu('8x H100 (80 GB SXM5)', 'H100 (80 GB SXM5)', 8)).toEqual({
			model: 'NVIDIA H100',
			count: 8,
			vramGb: 80
		});
		expect(gpu('8x Example GPU (40 GB SXM4)', 'Example GPU (40 GB SXM4)', 8)).toEqual({
			model: 'NVIDIA Example GPU',
			count: 8,
			vramGb: 40
		});
		// and others as Lambda writes them
		expect(gpu('1x A10 (24 GB PCIe)', 'A10 (24 GB PCIe)', 1)).toEqual({
			model: 'NVIDIA A10',
			count: 1,
			vramGb: 24
		});
		expect(gpu('8x Tesla V100 (16 GB)', 'Tesla V100 (16 GB)', 8)).toEqual({
			model: 'NVIDIA Tesla V100',
			count: 8,
			vramGb: 16
		});
		expect(gpu('2x RTX A6000 (48 GB)', 'RTX A6000 (48 GB)', 2)).toMatchObject({
			model: 'NVIDIA RTX A6000',
			vramGb: 48
		});
		expect(gpu('8x B200 (180 GB SXM6)', 'B200 (180 GB SXM6)', 8)?.vramGb).toBe(180);
		// the count from the description when the specs lack one; the model from it when gpu_description is empty
		expect(gpu('4x A100 (80 GB SXM4)', '')).toEqual({
			model: 'NVIDIA A100',
			count: 4,
			vramGb: 80
		});
		// no VRAM given, or an NVIDIA name already
		expect(gpu('1x NVIDIA L40S', 'NVIDIA L40S', 1)).toEqual({
			model: 'NVIDIA L40S',
			count: 1,
			vramGb: null
		});
		// a CPU-only size
		expect(gpu('CPU instance', '', 0)).toBeNull();

		const started = performance.now();
		const long = `${'9'.repeat(50_000)}x ${' ('.repeat(50_000)}${'1'.repeat(50_000)} GB`;
		expect(gpu(long, long, 1)).not.toBeNull();
		expect(performance.now() - started).toBeLessThan(100);
	});

	it('launches a tagged instance with cloud-init, a throwaway key and the mesh rule', async () => {
		const node = await adapter.createNode(creds(), spec({ name: 'GPU Box #1' }));
		expect(node).toMatchObject({ name: 'GPU Box #1', region: 'us-west-1', status: 'provisioning' });
		const [instance] = mine();
		expect(instance).toMatchObject({
			id: node.id,
			name: 'GPU Box #1',
			hostname: 'gpu-box-1',
			ssh_key_names: [SSH_KEY_NAME],
			tags: [{ key: 'tramline', value: 'node' }]
		});
		// rate-limited once, then launched
		expect(requests.filter((r) => r === 'POST instance-operations/launch')).toHaveLength(2);

		const userData = instance!.user_data!;
		expect(userData).toMatch(/^#cloud-config/);
		expect(userData).toContain("--token 'tljoin_abc'");
		// Lambda Stack has Docker, so cloud-init skips installing it
		expect(userData).toContain('if ! command -v docker');
		expect(userData).toContain(`ADDRESS=$(${LOCAL_PUBLIC_ADDRESS} || true)`);

		// the key is registered once, with no private half kept
		const key = sshKeys.find((k) => k.name === SSH_KEY_NAME)!;
		expect(key.public_key).toMatch(
			/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/=]+ tramline-no-login$/
		);
		await adapter.createNode(creds(), spec({ name: 'second' }));
		expect(sshKeys.filter((k) => k.name === SSH_KEY_NAME)).toHaveLength(1);
		expect(sshKeys.some((k) => k.name === 'my-laptop')).toBe(true);

		// the account's rules stay, the mesh rule is added once
		expect(firewall).toEqual([
			expect.objectContaining({ description: 'Allow SSH from anywhere' }),
			{ protocol: 'icmp', source_network: '0.0.0.0/0', description: 'Ping' },
			expect.objectContaining({ port_range: [8888, 8888], source_network: '203.0.113.7/32' }),
			{
				protocol: 'udp',
				port_range: [51820, 51820],
				source_network: '0.0.0.0/0',
				description: 'Tramline: WireGuard mesh between nodes'
			}
		]);
		expect(requests.filter((r) => r === 'PUT firewall-rules')).toHaveLength(1);

		expect(await adapter.getNode(creds(), node.id)).toMatchObject({
			status: 'running',
			address: expect.stringMatching(/^192\.0\.2\.\d+$/)
		});
	});

	it('leaves the firewall alone when a rule already covers the mesh, or when told to', async () => {
		firewall = [
			{ protocol: 'all', port_range: [1, 65535], source_network: '0.0.0.0/0', description: 'open' }
		];
		await adapter.createNode(creds(), spec());
		expect(requests).not.toContain('PUT firewall-rules');
		expect(mine()[0]!.user_data).toContain('ADDRESS=');

		reset();
		await adapter.createNode(creds({ openMeshPort: false }), spec());
		expect(requests.filter((r) => r.includes('firewall-rules'))).toEqual([]);
		// no open port, so no mesh endpoint: the node connects out to the others
		expect(mine()[0]!.user_data).not.toContain('ADDRESS=');

		// us-south-1 has no firewall rules to change
		reset();
		await adapter.createNode(creds(), spec({ region: 'us-south-1', name: 'texas' }));
		expect(requests.filter((r) => r.includes('firewall-rules'))).toEqual([]);
		expect(mine()[0]!.user_data).not.toContain('ADDRESS=');
	});

	it('says what to do when the key can’t change firewall rules, before launching anything', async () => {
		forbidFirewall = true;
		await expect(adapter.createNode(creds(), spec())).rejects.toThrow(
			/can’t change firewall rules.*Turn off “Open the mesh port”/
		);
		expect(mine()).toEqual([]);
	});

	it('explains a size with no room right now', async () => {
		noCapacity.add('gpu_1x_a10');
		await expect(adapter.createNode(creds(), spec())).rejects.toThrow(
			/none of that size free in this region right now.*Try another size or region/
		);
		expect(mine()).toEqual([]);
	});

	it('won’t launch a second instance with a node’s name, and only lists and terminates its own', async () => {
		const node = await adapter.createNode(creds(), spec());
		await expect(adapter.createNode(creds(), spec())).rejects.toThrow(
			/already has a Tramline instance called gpu-node/
		);
		expect((await adapter.listNodes(creds())).map((n) => n.id)).toEqual([node.id]);
		expect(await adapter.getNode(creds(), 'theirs0000000000000000000000000')).toBeNull();
		await expect(adapter.destroyNode(creds(), 'theirs0000000000000000000000000')).rejects.toThrow(
			/training-run wasn't created by Tramline, so it was left alone/
		);
		expect(instances.get('theirs0000000000000000000000000')!.status).toBe('active');
		await expect(adapter.getNode(creds(), '../ssh-keys')).rejects.toThrow(
			/isn't a Lambda instance ID/
		);

		// an instance launched with the throwaway key alone counts as Tramline's, even untagged
		instances.get(node.id)!.tags = [];
		expect((await adapter.listNodes(creds())).map((n) => n.id)).toEqual([node.id]);
		await adapter.destroyNode(creds(), node.id);
		await adapter.destroyNode(creds(), node.id);
		expect(requests.filter((r) => r === 'POST instance-operations/terminate')).toHaveLength(1);
		await adapter.destroyNode(creds(), '0000000000000000000000000000ffff');
	});

	it('waits out rate limits, and explains Lambda’s other refusals', async () => {
		const answering = (respond: () => Response) =>
			lambdaAdapter({ fetch: (async () => respond()) as typeof fetch, retryMs: 1 });
		let calls = 0;
		const limited = answering(() => {
			calls++;
			return lambdaError(429, 'global/rate-limited', 'Too many requests.');
		});
		await expect(limited.listRegions(creds())).rejects.toThrow(/limiting requests/);
		// the first try and four retries
		expect(calls).toBe(5);

		let waited = false;
		const once = answering(() => {
			if (waited) return json({ data: REGIONS });
			waited = true;
			return json({ error: { code: 'global/rate-limited' } }, 429, { 'retry-after': '0.001' });
		});
		expect(await once.listRegions(creds())).toHaveLength(3);

		const quota = answering(() => lambdaError(400, 'global/quota-exceeded', 'Quota exceeded.'));
		await expect(quota.listRegions(creds())).rejects.toThrow(
			/quota doesn’t allow this.*Lambda support/
		);
		const inactive = answering(() =>
			lambdaError(403, 'global/account-inactive', 'Your account is inactive.')
		);
		await expect(inactive.listRegions(creds())).rejects.toThrow(/account is inactive/);
		const billing = answering(() =>
			lambdaError(403, 'global/invalid-address', 'Your billing address is invalid.')
		);
		await expect(billing.listRegions(creds())).rejects.toThrow(/valid billing address/);
		const forbidden = answering(() => lambdaError(403, 'global/forbidden', 'Not authorized.'));
		await expect(forbidden.listRegions(creds())).rejects.toThrow(/API key’s role/);
		const broken = answering(() => new Response('<html>', { status: 502 }));
		await expect(broken.listRegions(creds())).rejects.toThrow(/^Lambda: HTTP 502$/);

		const offline = lambdaAdapter({
			fetch: (async () => {
				throw new Error('getaddrinfo ENOTFOUND');
			}) as typeof fetch
		});
		await expect(offline.validate(creds())).rejects.toThrow(/Couldn’t reach Lambda: getaddrinfo/);
	});

	it('names hosts the way Lambda allows', () => {
		expect(hostName('gpu-node')).toBe('gpu-node');
		expect(hostName('GPU_Box.1')).toBe('gpu-box-1');
		expect(hostName('1st')).toBe('1st');
		expect(hostName('---')).toBe('tramline-node');
		expect(hostName('a'.repeat(70))).toHaveLength(63);
		expect(hostName(`${'a'.repeat(62)}-b`)).toBe('a'.repeat(62));
		const started = performance.now();
		expect(hostName(`a${'-'.repeat(100_000)}b`)).toBe('a-b');
		expect(performance.now() - started).toBeLessThan(100);
		expect(throwawaySshKey()).not.toBe(throwawaySshKey());
	});
});

// a real account: TRAMLINE_LAMBDA_API_KEY, _REGION and _OFFER. It launches a GPU instance, which is billed.
describe.skipIf(!process.env.TRAMLINE_LAMBDA_API_KEY)('Lambda adapter against Lambda', () => {
	it('passes the conformance suite', { timeout: 30 * 60_000 }, async () => {
		const steps = await conformance(lambdaAdapter(), {
			credentials: creds({ apiKey: process.env.TRAMLINE_LAMBDA_API_KEY! }),
			region: process.env.TRAMLINE_LAMBDA_REGION ?? 'us-east-1',
			offer: process.env.TRAMLINE_LAMBDA_OFFER,
			goneWithinMs: 15 * 60_000,
			pollMs: 10_000
		});
		expect(steps).toContain('no orphans');
	});
});
