import { conformance, type NodeSpec } from '@tramline/adapter-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { ARM } from './client';
import { azureAdapter, offeredSize, vmName, type AzureCredentials } from './index';

/**
 * A fake Azure: Entra ID's token endpoint and enough of Resource Manager.
 * PUTs finish through an Azure-AsyncOperation URL and DELETEs through a
 * Location URL, each reporting "not yet" once, so waiting is exercised. A
 * NIC can't be deleted while a VM uses it, nor a public IP while a NIC does,
 * as in Azure; deleting a VM deletes its NIC and disk (deleteOption).
 */

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SECRET = 'abc~very-secret-value';
const SUB = '99999999-8888-7777-6666-555555555555';
const PREFIX = `${ARM}subscriptions/${SUB}`;

const creds = (overrides: Partial<AzureCredentials> = {}): AzureCredentials => ({
	tenantId: TENANT,
	clientId: CLIENT,
	clientSecret: SECRET,
	subscriptionId: SUB,
	resourceGroup: 'tramline',
	image: 'Canonical:ubuntu-24_04-lts:server:latest',
	diskGb: 30,
	openMeshPort: true,
	...overrides
});

interface Stored {
	name: string;
	location?: string;
	tags?: Record<string, string>;
	sku?: unknown;
	properties: Record<string, unknown>;
	managedBy?: string;
}

let resources: Map<string, Stored>;
let groups: Set<string>;
let operations: Map<string, { polls: number; error?: { code: string; message: string } }>;
let requests: string[];
let tokenRequests: number;
let registered: Set<string>;
let unavailable: Set<string>;
let forbidden: boolean;
let ipSeq: number;

function reset() {
	resources = new Map();
	groups = new Set();
	operations = new Map();
	requests = [];
	tokenRequests = 0;
	registered = new Set(['microsoft.compute', 'microsoft.network']);
	unavailable = new Set();
	forbidden = false;
	ipSeq = 0;
	// someone else's VM in the same group
	groups.add('tramline');
	resources.set('resourcegroups/tramline/providers/microsoft.compute/virtualmachines/theirs', {
		name: 'theirs',
		location: 'eastus',
		properties: { provisioningState: 'Succeeded' }
	});
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	Response.json(body, { status, headers });
const armError = (status: number, code: string, message: string) =>
	json({ error: { code, message } }, status);

let opSeq = 0;
function asyncOperation(error?: { code: string; message: string }) {
	const name = `op-${++opSeq}`;
	operations.set(name, { polls: 0, error });
	return `${PREFIX}/providers/Microsoft.Compute/locations/eastus/operations/${name}?api-version=2024-07-01`;
}

const SIZES = [
	{ name: 'Standard_D2s_v5', numberOfCores: 2, memoryInMB: 8192 },
	{ name: 'Standard_B1s', numberOfCores: 1, memoryInMB: 1024 },
	{ name: 'Standard_D2ps_v5', numberOfCores: 2, memoryInMB: 8192 },
	{ name: 'Standard_D32s_v5', numberOfCores: 32, memoryInMB: 131_072 },
	{ name: 'Standard_NC6s_v3', numberOfCores: 6, memoryInMB: 114_688 },
	{ name: 'Standard_DS1_v2', numberOfCores: 1, memoryInMB: 3584 },
	{ name: 'Standard_D2_v3', numberOfCores: 2, memoryInMB: 8192 },
	{ name: 'Standard_F2s_v2', numberOfCores: 2, memoryInMB: 4096 },
	{ name: 'Standard_B2s', numberOfCores: 2, memoryInMB: 4096 }
];

const instanceView = (vm: Stored) => ({
	...vm,
	properties: {
		...vm.properties,
		instanceView: {
			statuses: [
				{ code: `ProvisioningState/${String(vm.properties.provisioningState).toLowerCase()}` },
				{ code: 'PowerState/running' }
			]
		}
	}
});

async function handle(url: URL, init: RequestInit): Promise<Response> {
	const method = init.method ?? 'GET';
	if (url.origin === 'https://login.microsoftonline.com') {
		tokenRequests++;
		if (url.pathname !== `/${TENANT}/oauth2/v2.0/token`) {
			return json(
				{ error: 'invalid_request', error_description: `AADSTS90002: Tenant not found.` },
				400
			);
		}
		const form = new URLSearchParams(String(init.body));
		expect(form.get('scope')).toBe('https://management.azure.com/.default');
		expect(form.get('grant_type')).toBe('client_credentials');
		if (form.get('client_id') !== CLIENT) {
			return json(
				{ error: 'unauthorized_client', error_description: 'AADSTS700016: Application not found' },
				400
			);
		}
		if (form.get('client_secret') !== SECRET) {
			return json(
				{
					error: 'invalid_client',
					error_description: 'AADSTS7000215: Invalid client secret provided.\nTrace ID: x'
				},
				401
			);
		}
		return json({ access_token: 'eyJ.fake', expires_in: 3599, token_type: 'Bearer' });
	}
	expect(new Headers(init.headers).get('authorization')).toBe('Bearer eyJ.fake');
	expect(url.href.startsWith(PREFIX)).toBe(true);
	expect(url.searchParams.get('api-version')).toBeTruthy();
	const path = url.pathname.replace(`/subscriptions/${SUB}`, '').replace(/^\//, '').toLowerCase();
	requests.push(`${method} ${path}`);
	if (forbidden && method !== 'GET') {
		return armError(
			403,
			'AuthorizationFailed',
			`The client '${CLIENT}' does not have authorization to perform action.`
		);
	}
	const body = init.body ? JSON.parse(String(init.body)) : null;

	if (path === '') return json({ subscriptionId: SUB, displayName: 'Lab', state: 'Enabled' });
	let m = path.match(/^providers\/(microsoft\.\w+)$/);
	if (m) {
		return json({ registrationState: registered.has(m[1]!) ? 'Registered' : 'NotRegistered' });
	}
	if (path === 'locations') {
		if (url.searchParams.get('page') === '2') {
			return json({
				value: [
					{ name: 'westeurope', displayName: 'West Europe', metadata: { regionType: 'Physical' } }
				]
			});
		}
		return json({
			value: [
				{ name: 'eastus', displayName: 'East US', metadata: { regionType: 'Physical' } },
				{ name: 'eastus2euap', displayName: 'East US 2 EUAP', metadata: { regionType: 'Logical' } }
			],
			nextLink: `${PREFIX}/locations?api-version=2022-12-01&page=2`
		});
	}
	m = path.match(/^providers\/microsoft\.compute\/locations\/([^/]+)\/vmsizes$/);
	if (m) {
		if (!['eastus', 'westeurope'].includes(m[1]!)) {
			return armError(
				400,
				'NoRegisteredProviderFound',
				`No registered resource provider for ${m[1]}`
			);
		}
		return json({ value: SIZES });
	}
	m = path.match(/^providers\/microsoft\.compute\/locations\/[^/]+\/operations\/(.+)$/);
	if (m) {
		const op = operations.get(m[1]!)!;
		op.polls++;
		if (op.polls < 2) return json({ status: 'InProgress' });
		return op.error ? json({ status: 'Failed', error: op.error }) : json({ status: 'Succeeded' });
	}
	m = path.match(/^providers\/microsoft\.compute\/locations\/[^/]+\/deletes\/(.+)$/);
	if (m) {
		const op = operations.get(m[1]!)!;
		op.polls++;
		return op.polls < 2 ? json(null, 202) : json(null, 200);
	}

	m = path.match(/^resourcegroups\/([^/]+)$/);
	if (m) {
		if (method === 'PUT') {
			groups.add(m[1]!);
			return json({ name: m[1], location: body.location }, 201);
		}
		return groups.has(m[1]!)
			? json({ name: m[1], location: 'eastus' })
			: armError(404, 'ResourceGroupNotFound', `Resource group '${m[1]}' could not be found.`);
	}
	m = path.match(/^resourcegroups\/([^/]+)\/providers\/(.+)$/);
	if (!m) return armError(501, 'Unexpected', `unexpected ${method} ${path}`);
	if (!groups.has(m[1]!)) {
		return armError(404, 'ResourceGroupNotFound', `Resource group '${m[1]}' could not be found.`);
	}
	const segments = m[2]!.split('/');
	if (segments.length === 2) {
		// a collection: microsoft.compute/virtualmachines
		const value = [...resources]
			.filter(
				([key]) =>
					key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1
			)
			.map(([, r]) => (segments[1] === 'virtualmachines' ? instanceView(r) : r));
		return json({ value });
	}
	const key = path;
	const found = resources.get(key);
	const name = segments.at(-1)!;
	const type = segments[1];

	if (method === 'GET') {
		if (!found) return armError(404, 'ResourceNotFound', `The Resource '${name}' was not found.`);
		return json(url.searchParams.get('$expand') === 'instanceView' ? instanceView(found) : found);
	}
	if (method === 'PATCH') {
		if (!found) return armError(404, 'ResourceNotFound', `The Resource '${name}' was not found.`);
		found.tags = body.tags;
		return json(found);
	}
	if (method === 'PUT') {
		if (type === 'networksecuritygroups' && segments[3] === 'securityrules') {
			const nsg = resources.get(key.split('/securityrules/')[0]!)!;
			(nsg.properties.securityRules as unknown[]).push({ name, properties: body.properties });
			return json({ name }, 201, { 'azure-asyncoperation': asyncOperation() });
		}
		const stored: Stored = {
			name,
			location: body.location,
			tags: body.tags,
			sku: body.sku,
			properties: { ...body.properties, provisioningState: 'Succeeded' }
		};
		if (type === 'publicipaddresses') stored.properties.ipAddress = `20.42.0.${++ipSeq}`;
		let error: { code: string; message: string } | undefined;
		if (type === 'virtualmachines') {
			const size = (body.properties.hardwareProfile as { vmSize: string }).vmSize;
			if (unavailable.has(size)) {
				error = {
					code: 'SkuNotAvailable',
					message: `The requested VM size ${size} is currently not available in location 'eastus'.`
				};
			}
			// Azure makes the OS disk, without the VM's tags
			const disk = (body.properties.storageProfile as { osDisk: { name: string } }).osDisk.name;
			resources.set(`resourcegroups/${m[1]}/providers/microsoft.compute/disks/${disk}`, {
				name: disk,
				location: body.location,
				managedBy: key,
				properties: {}
			});
		}
		resources.set(key, stored);
		return json(stored, 201, { 'azure-asyncoperation': asyncOperation(error) });
	}
	if (method === 'DELETE') {
		if (!found) return json(null, 204);
		const inUse = [...resources.values()].some(
			(r) => JSON.stringify(r.properties).includes(`/${name}"`) && r !== found
		);
		if (inUse && type !== 'virtualmachines') {
			return armError(400, 'InUseByAnotherResource', `${name} is in use`);
		}
		resources.delete(key);
		if (type === 'virtualmachines') {
			// deleteOption: Delete on the NIC and the OS disk
			for (const [k, r] of resources) {
				if (k.endsWith(`/networkinterfaces/${name}-nic`) || r.managedBy === key)
					resources.delete(k);
			}
		}
		const op = `op-${++opSeq}`;
		operations.set(op, { polls: 0 });
		return json(null, 202, {
			location: `${PREFIX}/providers/Microsoft.Compute/locations/eastus/deletes/${op}?api-version=2024-07-01`
		});
	}
	return armError(501, 'Unexpected', `unexpected ${method} ${path}`);
}

const fetcher = (async (input: string | URL, init: RequestInit = {}) =>
	handle(new URL(String(input)), init)) as typeof fetch;

const adapter = azureAdapter({ fetch: fetcher, pollMs: 1 });

const spec = (overrides: Partial<NodeSpec> = {}): NodeSpec => ({
	name: 'azure-node',
	region: 'eastus',
	offer: 'Standard_B1s',
	install: {
		url: 'https://tramline.example.com',
		token: 'tljoin_abc',
		command: 'curl … | sudo sh'
	},
	userData: '#cloud-config',
	seedUrl: 'https://tramline.example.com/api/agent/v1/seed/x/',
	...overrides
});

const resource = (type: string, name: string) =>
	resources.get(`resourcegroups/tramline/providers/${type}/${name}`);

beforeEach(reset);

describe('Azure adapter', () => {
	it('passes the conformance suite', async () => {
		const steps = await conformance(adapter, {
			credentials: creds(),
			invalidCredentials: creds({ clientSecret: 'wrong' }),
			region: 'eastus',
			offer: 'Standard_B1s',
			pollMs: 1
		});
		expect(steps).toContain('no orphans');
		// only the region's network, security groups, and someone else's VM, are left
		expect([...resources.keys()].sort()).toEqual([
			'resourcegroups/tramline/providers/microsoft.compute/virtualmachines/theirs',
			'resourcegroups/tramline/providers/microsoft.network/applicationsecuritygroups/tramline-edge-eastus',
			'resourcegroups/tramline/providers/microsoft.network/networksecuritygroups/tramline-eastus',
			'resourcegroups/tramline/providers/microsoft.network/virtualnetworks/tramline-eastus'
		]);
	});

	it('checks the IDs before calling Azure, and fills in the defaults', () => {
		const schema = adapter.credentials;
		expect(schema.safeParse(creds({ clientId: 'my-app' })).success).toBe(false);
		expect(schema.safeParse(creds({ diskGb: 20 })).success).toBe(false);
		expect(schema.safeParse(creds({ image: 'ubuntu' })).success).toBe(false);
		expect(schema.safeParse(creds({ resourceGroup: 'ends.' })).success).toBe(false);
		const { resourceGroup, image, diskGb, openMeshPort, ...required } = creds();
		void [resourceGroup, image, diskGb, openMeshPort];
		expect(schema.parse(required)).toMatchObject({
			resourceGroup: 'tramline',
			image: 'Canonical:ubuntu-24_04-lts:server:latest',
			diskGb: 30,
			openMeshPort: true
		});
	});

	it('explains a wrong secret, client, tenant and an unregistered provider', async () => {
		await expect(adapter.validate(creds({ clientSecret: 'nope' }))).rejects.toThrow(
			/refused the client secret.*Value \(not its Secret ID\)/
		);
		await expect(
			adapter.validate(creds({ clientId: '00000000-0000-0000-0000-000000000000' }))
		).rejects.toThrow(/no app with that client ID/);
		await expect(adapter.validate(creds({ tenantId: 'contoso.example' }))).rejects.toThrow(
			/no tenant with that ID/
		);
		registered.delete('microsoft.network');
		await expect(adapter.validate(creds())).rejects.toThrow(/hasn’t registered Microsoft\.Network/);
	});

	it('signs in once and reuses the access token', async () => {
		const fresh = creds({ clientSecret: SECRET });
		await adapter.validate(fresh);
		const before = tokenRequests;
		await adapter.validate(fresh);
		await adapter.listRegions(fresh);
		expect(tokenRequests).toBe(before);
	});

	it('lists physical regions over every page', async () => {
		expect(await adapter.listRegions(creds())).toEqual([
			{ id: 'eastus', name: 'eastus (East US)' },
			{ id: 'westeurope', name: 'westeurope (West Europe)' }
		]);
	});

	it('offers general-purpose x86 sizes up to 16 vCPUs, smallest first', async () => {
		const offers = await adapter.listOffers(creds(), 'eastus');
		expect(offers.map((o) => o.id)).toEqual([
			'Standard_B1s',
			'Standard_B2s',
			'Standard_F2s_v2',
			'Standard_D2s_v5'
		]);
		expect(offers[0]).toMatchObject({ vcpus: 1, memoryMb: 1024, diskGb: 30, arch: 'amd64' });
		await expect(adapter.listOffers(creds(), 'moon')).rejects.toThrow(/no region called moon/);
		expect(offeredSize('Standard_E4as_v5')).toBe(true);
		expect(offeredSize('Standard_B2als_v2')).toBe(true);
		expect(offeredSize('Standard_D2ps_v5')).toBe(false);
		expect(offeredSize('Standard_D2_v3')).toBe(false);
	});

	it('creates a tagged VM with its address in cloud-init, no password and no usable SSH key', async () => {
		groups.clear();
		const node = await adapter.createNode(creds(), spec());
		expect(node).toEqual({
			id: 'azure-node',
			name: 'azure-node',
			region: 'eastus',
			status: 'provisioning',
			address: '20.42.0.1',
			instructions: null
		});
		expect(groups.has('tramline')).toBe(true);

		const nsg = resource('microsoft.network', 'networksecuritygroups/tramline-eastus')!;
		expect(nsg.properties.securityRules).toEqual([
			expect.objectContaining({
				name: 'tramline-mesh',
				properties: expect.objectContaining({
					protocol: 'Udp',
					destinationPortRange: '51820',
					access: 'Allow',
					direction: 'Inbound'
				})
			})
		]);
		const vnet = resource('microsoft.network', 'virtualnetworks/tramline-eastus')!;
		expect(JSON.stringify(vnet.properties)).toContain('networkSecurityGroups/tramline-eastus');

		const ip = resource('microsoft.network', 'publicipaddresses/azure-node-ip')!;
		expect(ip).toMatchObject({ tags: { tramline: 'node' }, sku: { name: 'Standard' } });
		const vm = resource('microsoft.compute', 'virtualmachines/azure-node')!;
		expect(vm.tags).toEqual({ tramline: 'node' });
		const properties = vm.properties as {
			hardwareProfile: unknown;
			storageProfile: { imageReference: unknown; osDisk: Record<string, unknown> };
			osProfile: {
				customData: string;
				adminPassword?: string;
				linuxConfiguration: {
					disablePasswordAuthentication: boolean;
					ssh: { publicKeys: { keyData: string }[] };
				};
			};
			securityProfile: unknown;
			diagnosticsProfile: unknown;
		};
		expect(properties.hardwareProfile).toEqual({ vmSize: 'Standard_B1s' });
		expect(properties.storageProfile.imageReference).toEqual({
			publisher: 'Canonical',
			offer: 'ubuntu-24_04-lts',
			sku: 'server',
			version: 'latest'
		});
		expect(properties.storageProfile.osDisk).toMatchObject({
			diskSizeGB: 30,
			deleteOption: 'Delete'
		});
		expect(properties.securityProfile).toMatchObject({ securityType: 'TrustedLaunch' });
		expect(properties.diagnosticsProfile).toEqual({ bootDiagnostics: { enabled: true } });
		const userData = Buffer.from(properties.osProfile.customData, 'base64').toString();
		expect(userData).toMatch(/^#cloud-config/);
		expect(userData).toContain("--token 'tljoin_abc'");
		expect(userData).toContain('ADDRESS=$(echo 20.42.0.1 || true)');
		expect(properties.osProfile.adminPassword).toBeUndefined();
		expect(properties.osProfile.linuxConfiguration.disablePasswordAuthentication).toBe(true);
		expect(properties.osProfile.linuxConfiguration.ssh.publicKeys[0]!.keyData).toMatch(
			/^ssh-rsa AAAAB3NzaC1yc2E[A-Za-z0-9+/=]+ tramline-no-login$/
		);
		// the OS disk is tagged afterwards, so it's cleaned up too
		expect(resource('microsoft.compute', 'disks/azure-node-disk')!.tags).toEqual({
			tramline: 'node'
		});

		expect(await adapter.getNode(creds(), 'azure-node')).toMatchObject({
			status: 'running',
			address: '20.42.0.1'
		});
	});

	it('adds the mesh rule to an existing security group, keeping its rules, and can leave it closed', async () => {
		resources.set(
			'resourcegroups/tramline/providers/microsoft.network/networksecuritygroups/tramline-eastus',
			{
				name: 'tramline-eastus',
				properties: { securityRules: [{ name: 'their-rule' }] }
			}
		);
		await adapter.createNode(creds(), spec());
		const nsg = resource('microsoft.network', 'networksecuritygroups/tramline-eastus')!;
		expect((nsg.properties.securityRules as { name: string }[]).map((r) => r.name)).toEqual([
			'their-rule',
			'tramline-mesh'
		]);

		await adapter.createNode(
			creds({ openMeshPort: false }),
			spec({ region: 'westeurope', name: 'b' })
		);
		expect(
			resource('microsoft.network', 'networksecuritygroups/tramline-westeurope')!.properties
				.securityRules
		).toEqual([]);
	});

	it('cleans up everything when the size isn’t available', async () => {
		unavailable.add('Standard_D2s_v5');
		await expect(adapter.createNode(creds(), spec({ offer: 'Standard_D2s_v5' }))).rejects.toThrow(
			/isn’t available in this region.*Try another size or region/
		);
		expect([...resources.keys()].filter((k) => k.includes('azure-node'))).toEqual([]);
	});

	it('won’t reuse a name, and only lists and destroys VMs it created', async () => {
		await adapter.createNode(creds(), spec());
		await expect(adapter.createNode(creds(), spec())).rejects.toThrow(
			/already has a VM called azure-node/
		);
		expect((await adapter.listNodes(creds())).map((n) => [n.id, n.address])).toEqual([
			['azure-node', '20.42.0.1']
		]);
		expect(await adapter.getNode(creds(), 'theirs')).toBeNull();
		await expect(adapter.destroyNode(creds(), 'theirs')).rejects.toThrow(/left alone/);
		expect(resource('microsoft.compute', 'virtualmachines/theirs')).toBeDefined();
		expect(await adapter.listNodes(creds({ resourceGroup: 'empty' }))).toEqual([]);
	});

	it('says which role is missing when it can’t create things', async () => {
		forbidden = true;
		await expect(adapter.createNode(creds(), spec())).rejects.toThrow(
			/Give the app the Contributor role/
		);
	});

	it('opens TCP 80 and 443 to an edge VM’s NIC only, through an application security group', async () => {
		await adapter.createNode(creds(), spec());
		const nicGroups = () =>
			(
				resource('microsoft.network', 'networkinterfaces/azure-node-nic')!.properties
					.ipConfigurations as { properties: { applicationSecurityGroups?: { id: string }[] } }[]
			)[0]!.properties.applicationSecurityGroups ?? [];
		const asgId = `/subscriptions/${SUB}/resourceGroups/tramline/providers/Microsoft.Network/applicationSecurityGroups/tramline-edge-eastus`;

		await adapter.setEdge!(creds(), 'azure-node', true);
		expect(nicGroups()).toEqual([{ id: asgId }]);
		expect(
			resource('microsoft.network', 'applicationsecuritygroups/tramline-edge-eastus')
		).toMatchObject({
			location: 'eastus',
			tags: { tramline: 'network' }
		});
		const rules = resource('microsoft.network', 'networksecuritygroups/tramline-eastus')!.properties
			.securityRules as { name: string; properties: Record<string, unknown> }[];
		expect(rules.map((r) => r.name)).toEqual(['tramline-mesh', 'tramline-edge']);
		expect(rules[1]!.properties).toMatchObject({
			protocol: 'Tcp',
			sourceAddressPrefix: '*',
			destinationApplicationSecurityGroups: [{ id: asgId }],
			destinationPortRanges: ['80', '443'],
			access: 'Allow',
			direction: 'Inbound'
		});
		// the rule is for the group, not the whole region's subnet
		expect(rules[1]!.properties.destinationAddressPrefix).toBeUndefined();

		// opening again changes nothing
		const before = requests.length;
		await adapter.setEdge!(creds(), 'azure-node', true);
		expect(requests.slice(before).filter((r) => !r.startsWith('GET'))).toEqual([]);

		await adapter.setEdge!(creds(), 'azure-node', false);
		expect(nicGroups()).toEqual([]);
		const after = requests.length;
		await adapter.setEdge!(creds(), 'azure-node', false);
		expect(requests.slice(after).filter((r) => !r.startsWith('GET'))).toEqual([]);

		// a VM that's gone has nothing to close, and can't be opened
		await adapter.setEdge!(creds(), 'gone', false);
		await expect(adapter.setEdge!(creds(), 'gone', true)).rejects.toThrow(/There is no VM gone/);
	});

	it('only touches VMs and groups it created', async () => {
		resources.set(
			'resourcegroups/tramline/providers/microsoft.network/networkinterfaces/theirs-nic',
			{
				name: 'theirs-nic',
				location: 'eastus',
				properties: { ipConfigurations: [] }
			}
		);
		await expect(adapter.setEdge!(creds(), 'theirs', true)).rejects.toThrow(/left alone/);

		await adapter.createNode(creds(), spec());
		const nsgKey =
			'resourcegroups/tramline/providers/microsoft.network/networksecuritygroups/tramline-eastus';
		const nsg = resources.get(nsgKey)!;
		resources.set(nsgKey, { ...nsg, tags: {} });
		await expect(adapter.setEdge!(creds(), 'azure-node', true)).rejects.toThrow(
			/security group tramline-eastus is missing or wasn't created by Tramline/
		);
		resources.set(nsgKey, nsg);
		const asgKey =
			'resourcegroups/tramline/providers/microsoft.network/applicationsecuritygroups/tramline-edge-eastus';
		resources.set(asgKey, { ...resources.get(asgKey)!, tags: {} });
		await expect(adapter.setEdge!(creds(), 'azure-node', true)).rejects.toThrow(
			/application security group tramline-edge-eastus wasn't created by Tramline/
		);
	});

	it('names VMs the way Azure allows', () => {
		expect(vmName('azure-node')).toBe('azure-node');
		expect(vmName('GPU_Box.1')).toBe('gpu-box-1');
		expect(vmName('1st')).toBe('tl-1st');
		expect(vmName('a'.repeat(70))).toHaveLength(50);
		const started = performance.now();
		expect(vmName(`a${'-'.repeat(100_000)}b`)).toBe('a-b');
		expect(performance.now() - started).toBeLessThan(100);
	});
});

// a real subscription: TRAMLINE_AZURE_TENANT, _CLIENT, _SECRET, _SUBSCRIPTION and _REGION
describe.skipIf(!process.env.TRAMLINE_AZURE_SECRET)('Azure adapter against Azure', () => {
	it('passes the conformance suite', { timeout: 20 * 60_000 }, async () => {
		const steps = await conformance(azureAdapter(), {
			credentials: creds({
				tenantId: process.env.TRAMLINE_AZURE_TENANT!,
				clientId: process.env.TRAMLINE_AZURE_CLIENT!,
				clientSecret: process.env.TRAMLINE_AZURE_SECRET!,
				subscriptionId: process.env.TRAMLINE_AZURE_SUBSCRIPTION!,
				resourceGroup: 'tramline-conformance'
			}),
			region: process.env.TRAMLINE_AZURE_REGION ?? 'eastus',
			offer: 'Standard_B1s',
			pollMs: 5_000
		});
		expect(steps).toContain('no orphans');
	});
});
