import { conformance, type NodeSpec } from '@tramline/adapter-sdk';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BILLING, COMPUTE } from './client';
import {
	gcpAdapter,
	instanceName,
	METADATA_ADDRESS,
	PRICES_RETRY_MS,
	PRICES_TTL_MS,
	type GcpCredentials,
	type GcpOptions
} from './index';
import { addSku, money, PREMIUM_EGRESS_PER_GB, priceOf, type RateTable, type Sku } from './prices';

/**
 * A fake Google Cloud: the OAuth token endpoint (which checks the JWT's
 * signature against the key's public half), enough of Compute Engine, and
 * the Cloud Billing catalog. Operations report RUNNING once before DONE, so
 * waiting is exercised.
 */

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (k: typeof keys) => k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const EMAIL = 'tramline@lab-123.iam.gserviceaccount.com';

const keyJson = (privateKey = pem(keys), email = EMAIL) =>
	JSON.stringify({
		type: 'service_account',
		project_id: 'lab-123',
		private_key_id: 'abc',
		private_key: privateKey,
		client_email: email,
		token_uri: 'https://oauth2.googleapis.com/token'
	});

const creds = (overrides: Partial<GcpCredentials> = {}): GcpCredentials => ({
	serviceAccountKey: keyJson(),
	network: 'default',
	image: 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64',
	diskGb: 20,
	openMeshPort: true,
	...overrides
});

interface Vm {
	name: string;
	zone: string;
	status: string;
	labels?: Record<string, string>;
	tags?: { items: string[]; fingerprint: string };
	body?: Record<string, unknown>;
	networkInterfaces?: unknown[];
}

let vms: Vm[];
let firewalls: Map<string, Record<string, unknown>>;
let operations: Map<string, { polls: number; error?: { code: string; message: string } }>;
let requests: string[];
let tokenRequests: number;
let exhausted: Set<string>;
let forbidFirewalls: boolean;
let apiDisabled: boolean;
let staleTags: boolean;
let catalog: Sku[][];
let catalogRequests: URL[];
/** Replaces the catalog's answer, e.g. with an error or junk. */
let catalogResponse: (() => Promise<Response>) | null;

function reset() {
	vms = [
		{
			name: 'someone-elses-vm',
			zone: `${COMPUTE}projects/lab-123/zones/us-central1-a`,
			status: 'RUNNING',
			tags: { items: ['web'], fingerprint: 'fp-0' }
		}
	];
	firewalls = new Map();
	operations = new Map();
	requests = [];
	tokenRequests = 0;
	exhausted = new Set();
	forbidFirewalls = false;
	apiDisabled = false;
	staleTags = false;
	catalog = CATALOG;
	catalogRequests = [];
	catalogResponse = null;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const googleError = (status: number, message: string, reason: string) =>
	json({ error: { code: status, message, errors: [{ reason, message }] } }, status);

let opSeq = 0;
function operation(zone: string | null, error?: { code: string; message: string }) {
	const name = `operation-${++opSeq}`;
	operations.set(name, { polls: 0, error });
	return json({
		name,
		status: 'RUNNING',
		...(zone ? { zone: `${COMPUTE}projects/lab-123/zones/${zone}` } : {})
	});
}

const ZONES: Record<string, string[]> = {
	'us-central1': ['us-central1-c', 'us-central1-a', 'us-central1-b'],
	'europe-west2': ['europe-west2-a']
};

const MACHINE_TYPES = [
	{ name: 'e2-standard-2', guestCpus: 2, memoryMb: 8192 },
	{ name: 'n2-standard-4', guestCpus: 4, memoryMb: 16_384 },
	{ name: 'n2d-standard-2', guestCpus: 2, memoryMb: 8192 },
	{ name: 'c4-standard-2', guestCpus: 2, memoryMb: 7680 },
	{ name: 'e2-micro', guestCpus: 2, memoryMb: 1024 },
	{ name: 'n2-standard-32', guestCpus: 32, memoryMb: 131_072 },
	{ name: 'a2-highgpu-1g', guestCpus: 12, memoryMb: 87_040 },
	{ name: 'm1-ultramem-40', guestCpus: 40, memoryMb: 980_000 },
	{ name: 'n1-standard-1', guestCpus: 1, memoryMb: 3840, deprecated: { state: 'DEPRECATED' } },
	{ name: 'e2-medium', guestCpus: 2, memoryMb: 4096 }
];

/** A Compute Engine machine SKU, shaped as the catalog sends it. */
const sku = (
	description: string,
	regions: string[],
	price: { units?: string; nanos: number },
	{ usageType = 'OnDemand', usageUnit = description.includes(' Ram ') ? 'GiBy.h' : 'h' } = {}
): Sku => ({
	description,
	category: { resourceFamily: 'Compute', usageType },
	serviceRegions: regions,
	pricingInfo: [
		{
			pricingExpression: {
				usageUnit,
				tieredRates: [
					{ unitPrice: { currencyCode: 'USD', units: price.units ?? '0', nanos: price.nanos } }
				]
			}
		}
	]
});

const AMERICAS = ['us-central1', 'us-east1', 'us-west1'];
const E2_CORE = 0.021811;
const E2_RAM = 0.002923;
const N2_CORE = 0.031611;
const N2_RAM = 0.004237;

/** Two pages, with each family's core and RAM rates on different pages. */
const CATALOG: Sku[][] = [
	[
		sku('E2 Instance Core running in Americas', AMERICAS, { nanos: 21_811_000 }),
		sku('E2 Instance Core running in London', ['europe-west2'], { nanos: 28_103_000 }),
		sku('N2 Instance Core running in Americas', AMERICAS, { nanos: 31_611_000 }),
		sku('N2D AMD Instance Core running in Americas', AMERICAS, { nanos: 27_502_000 }),
		// none of these price a predefined machine, and would spoil the N2 rates if matched
		sku(
			'Commitment v1: N2 Cpu in Americas for 1 Year',
			AMERICAS,
			{ nanos: 19_915_000 },
			{
				usageType: 'Commit1Yr'
			}
		),
		sku(
			'N2 Instance Core running in Americas',
			AMERICAS,
			{ nanos: 19_915_000 },
			{
				usageType: 'Commit1Yr'
			}
		),
		sku('N2 Custom Instance Core running in Americas', AMERICAS, { nanos: 33_191_000 }),
		sku('N2 Sole Tenancy Instance Core running in Americas', AMERICAS, { nanos: 34_772_000 }),
		sku(
			'Spot Preemptible E2 Instance Core running in Americas',
			AMERICAS,
			{ nanos: 6_543_000 },
			{
				usageType: 'Preemptible'
			}
		),
		{
			description: 'Network Internet Egress from Americas to Americas',
			category: { resourceFamily: 'Network', usageType: 'OnDemand' },
			serviceRegions: AMERICAS,
			pricingInfo: [{ pricingExpression: { usageUnit: 'GiBy', tieredRates: [] } }]
		}
	],
	[
		sku('E2 Instance Ram running in Americas', AMERICAS, { nanos: 2_923_000 }),
		sku('E2 Instance Ram running in London', ['europe-west2'], { nanos: 3_766_000 }),
		sku('N2 Instance Ram running in Americas', AMERICAS, { nanos: 4_237_000 }),
		sku('N2 Custom Extended Instance Ram running in Americas', AMERICAS, { nanos: 9_550_000 }),
		sku('N2 Custom Instance Ram running in Americas', AMERICAS, { nanos: 4_449_000 }),
		sku(
			'Spot Preemptible E2 Instance Ram running in Americas',
			AMERICAS,
			{ nanos: 877_000 },
			{
				usageType: 'Preemptible'
			}
		)
		// no N2D RAM rate, so n2d can't be priced; no C4 SKUs at all
	]
];

function catalogPage(url: URL) {
	catalogRequests.push(url);
	if (catalogResponse) return catalogResponse();
	expect(url.pathname).toBe('/v1/services/6F81-5844-456A/skus');
	expect(url.searchParams.get('currencyCode')).toBe('USD');
	expect(url.searchParams.get('pageSize')).toBe('5000');
	const page = Number(url.searchParams.get('pageToken')?.replace('page-', '') ?? 0);
	return Promise.resolve(
		json({
			skus: catalog[page] ?? [],
			...(page + 1 < catalog.length ? { nextPageToken: `page-${page + 1}` } : {})
		})
	);
}

/** Google's answer when the Cloud Billing API is off in the project. */
const billingDisabled = async () =>
	json(
		{
			error: {
				code: 403,
				message:
					'Cloud Billing API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/cloudbilling.googleapis.com/overview?project=123 then retry.',
				status: 'PERMISSION_DENIED',
				details: [
					{
						'@type': 'type.googleapis.com/google.rpc.ErrorInfo',
						reason: 'SERVICE_DISABLED',
						domain: 'googleapis.com',
						metadata: { service: 'cloudbilling.googleapis.com', consumer: 'projects/123' }
					}
				]
			}
		},
		403
	);

async function handle(url: URL, init: RequestInit): Promise<Response> {
	const method = init.method ?? 'GET';
	if (url.href === 'https://oauth2.googleapis.com/token') {
		tokenRequests++;
		const assertion = new URLSearchParams(String(init.body)).get('assertion')!;
		const [header, claims, signature] = assertion.split('.');
		const valid = createVerify('RSA-SHA256')
			.update(`${header}.${claims}`)
			.verify(keys.publicKey, signature!, 'base64url');
		const payload = JSON.parse(Buffer.from(claims!, 'base64url').toString());
		if (
			!valid ||
			payload.iss !== EMAIL ||
			payload.scope !==
				'https://www.googleapis.com/auth/compute https://www.googleapis.com/auth/cloud-billing.readonly'
		) {
			return json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400);
		}
		return json({ access_token: 'ya29.fake', expires_in: 3599, token_type: 'Bearer' });
	}
	expect(new Headers(init.headers).get('authorization')).toBe('Bearer ya29.fake');
	if (url.href.startsWith(BILLING)) return catalogPage(url);
	const prefix = `${COMPUTE}projects/lab-123/`;
	expect(url.href.startsWith(prefix)).toBe(true);
	const path = url.pathname.replace('/compute/v1/projects/lab-123/', '');
	requests.push(`${method} ${path}`);
	if (apiDisabled) {
		return googleError(
			403,
			'Compute Engine API has not been used in project lab-123 before or it is disabled.',
			'accessNotConfigured'
		);
	}
	const body = init.body ? JSON.parse(String(init.body)) : null;

	if (path === 'zones') return json({ items: [{ name: 'us-central1-a', status: 'UP' }] });
	if (path === 'regions') {
		return json({
			items: [
				{ name: 'us-central1', status: 'UP' },
				{ name: 'europe-west2', status: 'UP' },
				{ name: 'mars-north1', status: 'DOWN' },
				{ name: 'antarctica-south9', status: 'UP' }
			]
		});
	}
	let m = path.match(/^regions\/([^/]+)$/);
	if (m) {
		const zones = ZONES[m[1]!];
		if (!zones) return googleError(404, 'not found', 'notFound');
		return json({ name: m[1], zones: zones.map((z) => `${prefix}zones/${z}`) });
	}
	if (path === 'global/networks/default') return json({ name: 'default' });
	if (path.startsWith('global/networks/')) return googleError(404, 'not found', 'notFound');

	m = path.match(/^global\/firewalls(?:\/(.+))?$/);
	if (m) {
		if (forbidFirewalls) {
			return googleError(403, "Required 'compute.firewalls.get' permission", 'forbidden');
		}
		if (method === 'GET') {
			return firewalls.has(m[1]!)
				? json(firewalls.get(m[1]!))
				: googleError(404, 'not found', 'notFound');
		}
		firewalls.set(body.name, body);
		return operation(null);
	}
	m = path.match(/^(?:zones\/([^/]+)|global)\/operations\/(.+)$/);
	if (m) {
		const op = operations.get(m[2]!)!;
		op.polls++;
		return json({
			name: m[2],
			status: op.polls > 1 ? 'DONE' : 'RUNNING',
			...(m[1] ? { zone: `${prefix}zones/${m[1]}` } : {}),
			...(op.polls > 1 && op.error ? { error: { errors: [op.error] } } : {})
		});
	}
	m = path.match(/^zones\/([^/]+)\/machineTypes(?:\/(.+))?$/);
	if (m) {
		// europe-west2-a has no e2 machines in this fake
		const types = MACHINE_TYPES.filter(
			(t) => !(m![1] === 'us-central1-c' && t.name === 'e2-micro')
		);
		if (m[2]) {
			const found = types.find((t) => t.name === m![2]);
			return found ? json(found) : googleError(404, 'not found', 'notFound');
		}
		return json({ items: types });
	}
	if (path === 'aggregated/instances') {
		const items: Record<string, { instances: Vm[] }> = {};
		for (const vm of vms) {
			const zone = `zones/${vm.zone.split('/').pop()}`;
			(items[zone] ??= { instances: [] }).instances.push(vm);
		}
		return json({ items });
	}
	m = path.match(/^zones\/([^/]+)\/instances\/([^/]+)\/setTags$/);
	if (m && method === 'POST') {
		const vm = vms.find((v) => v.name === m![2] && v.zone.endsWith(`/zones/${m![1]}`));
		if (!vm) return googleError(404, 'not found', 'notFound');
		if (staleTags || body.fingerprint !== vm.tags?.fingerprint) {
			return googleError(
				412,
				'Supplied fingerprint does not match current metadata fingerprint.',
				'conditionNotMet'
			);
		}
		vm.tags = { items: body.items, fingerprint: `fp-${++opSeq}` };
		return operation(m[1]!);
	}
	m = path.match(/^zones\/([^/]+)\/instances(?:\/(.+))?$/);
	if (m) {
		const [, zone, name] = m;
		if (method === 'POST') {
			if (vms.some((v) => v.name === body.name)) {
				return googleError(409, `The resource '${body.name}' already exists`, 'alreadyExists');
			}
			const vm: Vm = {
				name: body.name,
				zone: `${prefix}zones/${zone}`,
				status: 'PROVISIONING',
				labels: body.labels,
				tags: { items: body.tags.items, fingerprint: 'fp-1' },
				body,
				networkInterfaces: [
					{
						network: `${prefix}global/networks/${body.networkInterfaces[0].network.split('/').pop()}`,
						accessConfigs: [{ natIP: '203.0.113.20' }]
					}
				]
			};
			vms.push(vm);
			if (exhausted.has(zone!)) {
				vm.status = 'TERMINATED';
				return operation(zone!, {
					code: 'ZONE_RESOURCE_POOL_EXHAUSTED',
					message: `The zone '${zone}' does not have enough resources available`
				});
			}
			return operation(zone!);
		}
		const vm = vms.find((v) => v.name === name && v.zone.endsWith(`/zones/${zone}`));
		if (!vm) return googleError(404, 'not found', 'notFound');
		if (method === 'GET') return json(vm);
		if (method === 'DELETE') {
			vms = vms.filter((v) => v !== vm);
			return operation(zone!);
		}
	}
	return googleError(501, `unexpected ${method} ${path}`, 'unexpected');
}

const fetcher = (async (input: string | URL, init: RequestInit = {}) =>
	handle(new URL(String(input)), init)) as typeof fetch;

const adapter = gcpAdapter({ fetch: fetcher, pollMs: 1 });
/** An adapter with its own price cache. */
const fresh = (options: GcpOptions = {}) => gcpAdapter({ fetch: fetcher, pollMs: 1, ...options });

const spec = (overrides: Partial<NodeSpec> = {}): NodeSpec => ({
	name: 'gcp-node',
	region: 'us-central1',
	offer: 'e2-micro',
	install: {
		url: 'https://tramline.example.com',
		token: 'tljoin_abc',
		command: 'curl … | sudo sh'
	},
	userData: '#cloud-config',
	seedUrl: 'https://tramline.example.com/api/agent/v1/seed/x/',
	...overrides
});

beforeEach(reset);

describe('GCP adapter', () => {
	it('passes the conformance suite', async () => {
		const steps = await conformance(adapter, {
			credentials: creds(),
			invalidCredentials: creds({ serviceAccountKey: keyJson(pem(other)) }),
			region: 'us-central1',
			pollMs: 1
		});
		expect(steps).toContain('no orphans');
		expect(vms.map((v) => v.name)).toEqual(['someone-elses-vm']);
	});

	it('rejects a key that isn’t a service account key, before calling Google', () => {
		const schema = adapter.credentials;
		expect(
			schema.safeParse(creds({ serviceAccountKey: '{"type":"authorized_user"}' })).success
		).toBe(false);
		expect(schema.safeParse(creds({ serviceAccountKey: 'not json' })).success).toBe(false);
		expect(schema.safeParse({ serviceAccountKey: keyJson() }).data).toMatchObject({
			network: 'default',
			diskGb: 20,
			openMeshPort: true
		});
	});

	it('explains a refused key, a missing network and a disabled API', async () => {
		await expect(
			adapter.validate(creds({ serviceAccountKey: keyJson(pem(other)) }))
		).rejects.toThrow(/Google refused the service account key: Invalid JWT Signature/);
		await expect(adapter.validate(creds({ network: 'prod-vpc' }))).rejects.toThrow(
			/no network called prod-vpc/
		);
		apiDisabled = true;
		await expect(adapter.validate(creds())).rejects.toThrow(
			/Compute Engine API is off in project lab-123/
		);
	});

	it('says which role is missing when it can’t manage firewall rules', async () => {
		forbidFirewalls = true;
		await expect(adapter.validate(creds())).rejects.toThrow(/Compute Security Admin/);
		await expect(adapter.validate(creds({ openMeshPort: false }))).resolves.toBeUndefined();
	});

	it('signs in once and reuses the access token', async () => {
		const once = gcpAdapter({ fetch: fetcher, pollMs: 1 });
		const key = keyJson(pem(keys), 'tramline@lab-123.iam.gserviceaccount.com');
		await once.listRegions(creds({ serviceAccountKey: key }));
		await once.listRegions(creds({ serviceAccountKey: key }));
		expect(tokenRequests).toBeLessThanOrEqual(1);
	});

	it('lists the regions that are up, with where they are', async () => {
		expect(await adapter.listRegions(creds())).toEqual([
			{ id: 'antarctica-south9', name: 'antarctica-south9' },
			{ id: 'europe-west2', name: 'europe-west2 (London)' },
			{ id: 'us-central1', name: 'us-central1 (Iowa)' }
		]);
	});

	it('offers general-purpose sizes up to 16 vCPUs, smallest first', async () => {
		const offers = await adapter.listOffers(creds(), 'us-central1');
		expect(offers.map((o) => o.id)).toEqual([
			'e2-micro',
			'e2-medium',
			'c4-standard-2',
			'e2-standard-2',
			'n2d-standard-2',
			'n2-standard-4'
		]);
		expect(offers[0]).toEqual({
			id: 'e2-micro',
			region: 'us-central1',
			name: 'e2-micro',
			vcpus: 2,
			memoryMb: 1024,
			diskGb: 20,
			arch: 'amd64',
			gpu: null,
			hourly: expect.any(Number),
			spotHourly: null,
			egressPerGb: 0.12
		});
		await expect(adapter.listOffers(creds(), 'nowhere1')).rejects.toThrow(
			/no region called nowhere1/
		);
	});

	it('creates a labelled VM with cloud-init, no service account and a public address', async () => {
		const node = await adapter.createNode(creds(), spec());
		// us-central1-a is the first zone with an e2-micro (the fake's -c has none)
		expect(node).toEqual({
			id: 'us-central1-a/gcp-node',
			name: 'gcp-node',
			region: 'us-central1',
			status: 'provisioning',
			address: null,
			instructions: null
		});
		const vm = vms.find((v) => v.name === 'gcp-node')!;
		expect(vm.body).toMatchObject({
			machineType: 'zones/us-central1-a/machineTypes/e2-micro',
			labels: { tramline: 'node' },
			tags: { items: ['tramline'] },
			serviceAccounts: [],
			disks: [
				{
					boot: true,
					autoDelete: true,
					initializeParams: {
						sourceImage: 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64',
						diskSizeGb: '20'
					}
				}
			],
			networkInterfaces: [
				{ network: 'global/networks/default', accessConfigs: [{ type: 'ONE_TO_ONE_NAT' }] }
			]
		});
		const userData = (vm.body!.metadata as { items: { key: string; value: string }[] }).items[0]!;
		expect(userData.key).toBe('user-data');
		expect(userData.value).toMatch(/^#cloud-config/);
		expect(userData.value).toContain(METADATA_ADDRESS);
		expect(userData.value).toContain("--token 'tljoin_abc' $ENDPOINT");

		// the mesh port is opened once, for VMs with the tag
		expect(firewalls.get('tramline-mesh-default')).toMatchObject({
			network: 'global/networks/default',
			allowed: [{ IPProtocol: 'udp', ports: ['51820'] }],
			targetTags: ['tramline']
		});
		await adapter.createNode(creds(), spec({ name: 'second' }));
		expect(requests.filter((r) => r === 'POST global/firewalls')).toHaveLength(1);

		expect(await adapter.getNode(creds(), node.id)).toMatchObject({
			status: 'provisioning',
			address: '203.0.113.20'
		});
	});

	it('tries the next zone when one has no room', async () => {
		exhausted.add('us-central1-a');
		const node = await adapter.createNode(creds(), spec());
		expect(node.id).toBe('us-central1-b/gcp-node');
		expect(vms.filter((v) => v.name === 'gcp-node')).toHaveLength(1);

		exhausted.add('us-central1-b');
		await expect(adapter.createNode(creds(), spec({ name: 'full' }))).rejects.toThrow(
			/No zone in us-central1 has room for a e2-micro right now/
		);
		expect(vms.some((v) => v.name === 'full')).toBe(false);
		await expect(
			adapter.createNode(
				creds(),
				spec({ name: 'x', region: 'europe-west2', offer: 'c4-standard-8' })
			)
		).rejects.toThrow(/No zone in europe-west2 offers c4-standard-8/);
	});

	it('won’t reuse a name, and leaves the firewall alone when asked to', async () => {
		await adapter.createNode(creds({ openMeshPort: false }), spec());
		expect(firewalls.size).toBe(0);
		await expect(adapter.createNode(creds({ openMeshPort: false }), spec())).rejects.toThrow(
			/already has a VM called gcp-node/
		);
	});

	it('only lists and destroys VMs it created', async () => {
		await adapter.createNode(creds(), spec());
		expect((await adapter.listNodes(creds())).map((n) => n.id)).toEqual(['us-central1-a/gcp-node']);
		expect(await adapter.getNode(creds(), 'us-central1-a/someone-elses-vm')).toBeNull();
		await expect(adapter.destroyNode(creds(), 'us-central1-a/someone-elses-vm')).rejects.toThrow(
			/wasn't created by Tramline/
		);
		await adapter.destroyNode(creds(), 'us-central1-a/gcp-node');
		await adapter.destroyNode(creds(), 'us-central1-a/gcp-node');
		expect(vms.map((v) => v.name)).toEqual(['someone-elses-vm']);
		await expect(adapter.destroyNode(creds(), '../etc')).rejects.toThrow(/isn't a GCP machine ID/);
	});

	it('explains failures it can’t recover from', async () => {
		const failing = (response: () => Promise<Response>) =>
			gcpAdapter({
				pollMs: 1,
				fetch: (async (input: string | URL, init: RequestInit = {}) =>
					String(input).includes('oauth2')
						? handle(new URL(String(input)), init)
						: response()) as typeof fetch
			});
		await expect(
			failing(() => Promise.reject(new Error('ECONNRESET'))).listRegions(creds())
		).rejects.toThrow(/Couldn’t reach Google Cloud: ECONNRESET/);
		await expect(
			failing(async () =>
				googleError(403, 'Billing account for project is not found', 'billing')
			).listRegions(creds())
		).rejects.toThrow(/needs a billing account/);
		await expect(
			failing(async () =>
				googleError(403, "Required 'compute.regions.list'", 'forbidden')
			).listRegions(creds())
		).rejects.toThrow(/Compute Instance Admin \(v1\)/);
		await expect(
			failing(async () => new Response('oops', { status: 502 })).listRegions(creds())
		).rejects.toThrow(/Google Cloud: HTTP 502/);

		const broken = keyJson('-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----');
		await expect(adapter.listRegions(creds({ serviceAccountKey: broken }))).rejects.toThrow(
			/private key couldn’t be read/
		);
		await expect(adapter.listRegions(creds({ serviceAccountKey: 'garbage' }))).rejects.toThrow(
			/isn’t a valid JSON key/
		);
	});

	it('can’t open the mesh port without the role, and reports the VM’s state', async () => {
		forbidFirewalls = true;
		await expect(adapter.createNode(creds(), spec())).rejects.toThrow(/Compute Security Admin/);
		forbidFirewalls = false;
		const node = await adapter.createNode(creds(), spec());
		const vm = vms.find((v) => v.name === 'gcp-node')!;
		for (const [status, expected] of [
			['RUNNING', 'running'],
			['STAGING', 'provisioning'],
			['TERMINATED', 'stopped'],
			['SOMETHING_NEW', 'unknown']
		] as const) {
			vm.status = status;
			expect((await adapter.getNode(creds(), node.id))!.status).toBe(expected);
		}
	});

	it('opens TCP 80 and 443 to an edge VM only, through its tag, and closes them again', async () => {
		const node = await adapter.createNode(creds(), spec());
		const vm = vms.find((v) => v.name === 'gcp-node')!;
		await adapter.setEdge!(creds(), node.id, true);
		expect(vm.tags!.items).toEqual(['tramline', 'tramline-edge']);
		expect(firewalls.get('tramline-edge-default')).toMatchObject({
			network: 'global/networks/default',
			direction: 'INGRESS',
			allowed: [{ IPProtocol: 'tcp', ports: ['80', '443'] }],
			sourceRanges: ['0.0.0.0/0'],
			targetTags: ['tramline-edge']
		});
		// the mesh rule is untouched, and opening again changes nothing
		expect(firewalls.get('tramline-mesh-default')!.targetTags).toEqual(['tramline']);
		const before = requests.length;
		await adapter.setEdge!(creds(), node.id, true);
		expect(requests.slice(before).filter((r) => r.startsWith('POST'))).toEqual([]);

		await adapter.setEdge!(creds(), node.id, false);
		expect(vm.tags!.items).toEqual(['tramline']);
		// the rule stays, matching nothing
		expect(firewalls.has('tramline-edge-default')).toBe(true);
		await adapter.setEdge!(creds(), node.id, false);
		expect(requests.filter((r) => r.endsWith('/setTags'))).toHaveLength(2);

		// a VM that's gone has nothing to close, and can't be opened
		await adapter.setEdge!(creds(), 'us-central1-a/gone', false);
		await expect(adapter.setEdge!(creds(), 'us-central1-a/gone', true)).rejects.toThrow(
			/There is no VM/
		);
	});

	it('only tags VMs it created, and says which role opening the ports needs', async () => {
		await expect(adapter.setEdge!(creds(), 'us-central1-a/someone-elses-vm', true)).rejects.toThrow(
			/wasn't created by Tramline/
		);
		expect(vms[0]!.tags!.items).toEqual(['web']);

		const node = await adapter.createNode(creds({ openMeshPort: false }), spec());
		forbidFirewalls = true;
		await expect(adapter.setEdge!(creds(), node.id, true)).rejects.toThrow(
			/Compute Security Admin, or allow TCP 80 and 443 to VMs tagged “tramline-edge”/
		);
		forbidFirewalls = false;
		// tags changed by someone else since they were read: Google refuses, and nothing changes
		staleTags = true;
		await expect(adapter.setEdge!(creds(), node.id, true)).rejects.toThrow(/fingerprint/);
		expect(vms.find((v) => v.name === 'gcp-node')!.tags!.items).toEqual(['tramline']);
	});

	it('names VMs the way GCE allows', () => {
		expect(instanceName('gcp-node')).toBe('gcp-node');
		expect(instanceName('GPU_Box.1')).toBe('gpu-box-1');
		expect(instanceName('1st')).toBe('tl-1st');
		expect(instanceName('a'.repeat(70) + '-b')).toHaveLength(63);
		expect(instanceName('--a--b--')).toBe('a-b');
		expect(instanceName('a'.repeat(62) + '-b')).toBe('a'.repeat(62));
		// hyphen runs that once made trimming quadratic
		const started = performance.now();
		expect(instanceName(`a${'-'.repeat(100_000)}b`)).toBe('a-b');
		expect(performance.now() - started).toBeLessThan(100);
	});
});

describe('GCP prices', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const hourly = async (region = 'us-central1', a = fresh()) =>
		Object.fromEntries(
			(await a.listOffers(creds(), region)).map((o) => [o.id, o.hourly] as const)
		) as Record<string, number | null>;

	it('prices each size from its family’s core and RAM rates, read across every page', async () => {
		const prices = await hourly();
		expect(catalogRequests.map((u) => u.searchParams.get('pageToken'))).toEqual([null, 'page-1']);
		expect(prices['e2-standard-2']).toBeCloseTo(2 * E2_CORE + 8 * E2_RAM, 9);
		// the commitment, custom, extended and sole-tenancy N2 SKUs are ignored
		expect(prices['n2-standard-4']).toBeCloseTo(4 * N2_CORE + 16 * N2_RAM, 9);
		// shared-core E2 types bill a fraction of a vCPU
		expect(prices['e2-micro']).toBeCloseTo(0.25 * E2_CORE + 1 * E2_RAM, 9);
		expect(prices['e2-medium']).toBeCloseTo(1 * E2_CORE + 4 * E2_RAM, 9);
		// n2d has no RAM rate in the catalog, and c4 none at all: unknown, not guessed
		expect(prices['n2d-standard-2']).toBeNull();
		expect(prices['c4-standard-2']).toBeNull();
	});

	it('uses the rates for the offer’s own region', async () => {
		const a = fresh();
		const london = await hourly('europe-west2', a);
		expect(london['e2-standard-2']).toBeCloseTo(2 * 0.028103 + 8 * 0.003766, 9);
		expect(london['n2-standard-4']).toBeNull();
		// one read of the catalog serves every region
		expect((await hourly('us-central1', a))['e2-standard-2']).toBeCloseTo(
			2 * E2_CORE + 8 * E2_RAM,
			9
		);
		expect(catalogRequests).toHaveLength(2);
	});

	it('lists spot prices as unknown, since spot VMs aren’t offered', async () => {
		const a = fresh();
		expect(a.capabilities.spot).toBe(false);
		const offers = await a.listOffers(creds(), 'us-central1');
		expect(offers.every((o) => o.spotHourly === null)).toBe(true);
		expect(offers.every((o) => o.egressPerGb === PREMIUM_EGRESS_PER_GB)).toBe(true);
		// spot rates are read from Preemptible SKUs, and never taken for on-demand ones
		const table: RateTable = new Map();
		for (const page of CATALOG) for (const s of page) addSku(table, s);
		const e2 = { name: 'e2-standard-2', guestCpus: 2, memoryMb: 8192 };
		expect(priceOf(table, e2, 'us-central1', 'Preemptible')).toBeCloseTo(
			2 * 0.006543 + 8 * 0.000877,
			9
		);
		expect(priceOf(table, e2, 'us-central1', 'OnDemand')).toBeCloseTo(2 * E2_CORE + 8 * E2_RAM, 9);
		expect(priceOf(table, e2, 'asia-south9', 'OnDemand')).toBeNull();
		expect(priceOf(table, { ...e2, name: 'f1-micro' }, 'us-central1', 'OnDemand')).toBeNull();
	});

	it('reads Google’s money as units plus nanos', () => {
		expect(money({ currencyCode: 'USD', units: '1', nanos: 500_000_000 })).toBe(1.5);
		expect(money({ units: 2 })).toBe(2);
		expect(money({ nanos: 21_811_000 })).toBeCloseTo(0.021811, 12);
		expect(money({ currencyCode: 'EUR', units: '1' })).toBeNull();
		expect(money({ units: '-1' })).toBeNull();
		expect(money({ units: 'lots' })).toBeNull();
		expect(money(undefined)).toBeNull();
	});

	it('takes the last tier, and skips SKUs with the wrong shape', () => {
		const table: RateTable = new Map();
		const tiered = sku('E2 Instance Core running in Americas', ['us-central1'], { nanos: 0 });
		tiered.pricingInfo![0]!.pricingExpression!.tieredRates!.push({
			unitPrice: { currencyCode: 'USD', units: '0', nanos: 21_811_000 }
		});
		addSku(table, tiered);
		addSku(
			table,
			sku(
				'E2 Instance Ram running in Americas',
				['us-central1'],
				{ nanos: 1 },
				{
					usageUnit: 'h'
				}
			)
		);
		addSku(
			table,
			sku(
				'E2 Instance Ram running in Americas',
				['us-east1'],
				{ nanos: 1 },
				{
					usageType: 'Preemptible'
				}
			)
		);
		addSku(table, { description: 'E2 Instance Ram running in Americas' });
		addSku(table, {
			...sku('C3 Instance Core running in Americas', ['us-central1'], { nanos: 1 }),
			category: { resourceFamily: 'License', usageType: 'OnDemand' }
		});
		addSku(table, {});
		expect([...table]).toEqual([['us-central1|E2|OnDemand|core', 0.021811]]);
		// two different prices for the same rate: neither is trusted
		addSku(table, sku('E2 Instance Core running in Iowa', ['us-central1'], { nanos: 1 }));
		addSku(table, sku('E2 Instance Ram running in Iowa', ['us-central1'], { nanos: 1 }));
		const e2 = { name: 'e2-standard-2', guestCpus: 2, memoryMb: 8192 };
		expect(priceOf(table, e2, 'us-central1', 'OnDemand')).toBeNull();
	});

	it('lists offers with unknown prices when the Cloud Billing API is off, and still validates', async () => {
		catalogResponse = billingDisabled;
		const a = fresh();
		await expect(a.validate(creds())).resolves.toBeUndefined();
		expect(catalogRequests).toHaveLength(0);
		const offers = await a.listOffers(creds(), 'us-central1');
		expect(offers).toHaveLength(6);
		expect(offers.every((o) => o.hourly === null && o.spotHourly === null)).toBe(true);
	});

	it('lists unknown prices when the catalog can’t be read or makes no sense', async () => {
		for (const response of [
			() => Promise.reject(new Error('ECONNRESET')),
			async () => new Response('<html>oops</html>', { status: 502 }),
			async () => new Response('not json'),
			async () => json({ skus: 'many' }),
			async () => json({ skus: [] }),
			// a page token that never ends
			async () => json({ skus: CATALOG[0], nextPageToken: 'again' })
		]) {
			catalogResponse = response;
			const offers = await fresh().listOffers(creds(), 'us-central1');
			expect(offers.map((o) => o.hourly)).toEqual(offers.map(() => null));
		}
	});

	it('doesn’t keep listOffers waiting on a slow catalog, and uses it once it arrives', async () => {
		let answer!: () => void;
		const arrived = new Promise<void>((resolve) => (answer = resolve));
		catalogResponse = async () => {
			await arrived;
			catalogResponse = null;
			return catalogPage(catalogRequests.at(-1)!);
		};
		const a = fresh({ priceWaitMs: 5 });
		expect((await hourly('us-central1', a))['e2-standard-2']).toBeNull();
		answer();
		await vi.waitFor(() => expect(catalogRequests).toHaveLength(3));
		await vi.waitFor(async () =>
			expect((await hourly('us-central1', a))['e2-standard-2']).toBeCloseTo(
				2 * E2_CORE + 8 * E2_RAM,
				9
			)
		);
		expect(catalogRequests).toHaveLength(3);
	});

	it('keeps prices for a day, and retries a failed read after ten minutes', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
		const a = fresh();
		catalogResponse = billingDisabled;
		expect((await hourly('us-central1', a))['e2-micro']).toBeNull();
		expect(catalogRequests).toHaveLength(1);
		// the API is turned on, but the failure is remembered for a while
		catalogResponse = null;
		vi.setSystemTime(Date.now() + PRICES_RETRY_MS - 1000);
		expect((await hourly('us-central1', a))['e2-micro']).toBeNull();
		expect(catalogRequests).toHaveLength(1);
		vi.setSystemTime(Date.now() + 2000);
		expect((await hourly('us-central1', a))['e2-micro']).not.toBeNull();
		expect(catalogRequests).toHaveLength(3);

		// then the table serves every call for a day
		await hourly('europe-west2', a);
		vi.setSystemTime(Date.now() + PRICES_TTL_MS - 1000);
		await hourly('us-central1', a);
		expect(catalogRequests).toHaveLength(3);
		catalog = [
			[
				sku('E2 Instance Core running in Americas', AMERICAS, { nanos: 30_000_000 }),
				sku('E2 Instance Ram running in Americas', AMERICAS, { nanos: 4_000_000 })
			]
		];
		vi.setSystemTime(Date.now() + 2000);
		expect((await hourly('us-central1', a))['e2-standard-2']).toBeCloseTo(2 * 0.03 + 8 * 0.004, 9);
		expect(catalogRequests).toHaveLength(4);
	});
});

// a real project: TRAMLINE_GCP_KEY_FILE (a service account JSON key) and TRAMLINE_GCP_REGION
describe.skipIf(!process.env.TRAMLINE_GCP_KEY_FILE)('GCP adapter against Google Cloud', () => {
	it('passes the conformance suite', { timeout: 15 * 60_000 }, async () => {
		const { readFileSync } = await import('node:fs');
		const steps = await conformance(gcpAdapter(), {
			credentials: {
				serviceAccountKey: readFileSync(process.env.TRAMLINE_GCP_KEY_FILE!, 'utf8'),
				network: 'default',
				image: 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64',
				diskGb: 20,
				openMeshPort: true
			},
			region: process.env.TRAMLINE_GCP_REGION ?? 'us-central1',
			offer: 'e2-micro',
			pollMs: 5_000
		});
		expect(steps).toContain('no orphans');
	});
});
