import { AdapterError, fakeAdapter, FAKE_TOKEN, type NodeSpec } from '@tramline/adapter-sdk';
import type { AgentHello } from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { listAdapters, registerAdapter } from '../adapters/registry';
import { adapterAccount, node as nodeTable } from '../db/schema';
import { join } from '../nodes/registry';
import { grantInstallAdmin, seedCtx } from '../testing';
import * as adapters from './adapters';
import type { Ctx } from './context';
import * as nodes from './nodes';

const hello: AgentHello = {
	protocol: 1,
	agentVersion: 'test',
	hostname: 'vm',
	os: 'linux',
	arch: 'amd64',
	cpus: 2,
	memoryMb: 4096,
	docker: { version: '27.0.0' },
	gpus: [{ model: 'NVIDIA L4', vramMb: 23_034 }]
};

// one fake on the registry; each test sees its machines through `fake`
let fake = fakeAdapter();
let created: NodeSpec[] = [];
type Creds = Parameters<typeof fake.adapter.validate>[0];
registerAdapter({
	...fake.adapter,
	createNode: (creds: Creds, spec: NodeSpec) => fake.adapter.createNode(creds, spec),
	destroyNode: (creds: Creds, id: string) => fake.adapter.destroyNode(creds, id)
} as never);

beforeEach(() => {
	fake = fakeAdapter({ onCreate: (spec) => created.push(spec) });
	created = [];
});

const good = { apiToken: FAKE_TOKEN, project: 'lab' };

function setup() {
	const ctx = grantInstallAdmin(seedCtx());
	const account = adapters.createAccount(ctx, {
		adapter: 'fake',
		name: 'Fake lab',
		credentials: good
	});
	return { ctx, account };
}

const provision = (ctx: Ctx, account: string, name = 'gpu-1') =>
	adapters.provision(ctx, { account, name, region: 'fake-1', offer: 'gpu' }, 'http://t.test');

describe('adapter accounts', () => {
	it('lists the adapters with forms generated from their credentials', () => {
		const fakeInfo = listAdapters().find((a) => a.id === 'fake')!;
		expect(fakeInfo.fields.map((f) => [f.key, f.secret])).toEqual([
			['apiToken', true],
			['project', false]
		]);
		expect(
			listAdapters()
				.find((a) => a.id === 'proxmox')
				?.fields.map((f) => f.key)
		).toContain('fingerprint');
		expect(listAdapters().find((a) => a.id === 'manual')).toMatchObject({
			fields: [],
			capabilities: { autoProvision: false }
		});
	});

	it('stores credentials encrypted and never returns secrets', () => {
		const { ctx, account } = setup();
		expect(account.credentials).toEqual({ project: 'lab' });
		const row = ctx.db.select().from(adapterAccount).get()!;
		expect(row.credentials).not.toContain(FAKE_TOKEN);

		// a blank secret keeps the saved one
		const renamed = adapters.updateAccount(ctx, account.id, {
			name: 'Lab',
			credentials: { apiToken: '', project: 'other' }
		});
		expect(renamed).toMatchObject({ name: 'Lab', credentials: { project: 'other' } });
		expect(
			JSON.parse(ctx.secrets.decrypt(ctx.db.select().from(adapterAccount).get()!.credentials))
		).toEqual({
			apiToken: FAKE_TOKEN,
			project: 'other'
		});
	});

	it('is for install admins only, and refuses unknown adapters and duplicate names', () => {
		const { ctx } = setup();
		const outsider = seedCtx(ctx.db);
		expect(() => adapters.listAccounts(outsider)).toThrow("Only this install's admins");
		expect(() =>
			adapters.createAccount(ctx, { adapter: 'nimbus', name: 'x', credentials: {} })
		).toThrow('There is no nimbus adapter');
		expect(() =>
			adapters.createAccount(ctx, { adapter: 'manual', name: 'x', credentials: {} })
		).toThrow('need no account');
		expect(() =>
			adapters.createAccount(ctx, { adapter: 'fake', name: 'Fake lab', credentials: good })
		).toThrow('already an account called Fake lab');
		expect(() =>
			adapters.createAccount(ctx, { adapter: 'fake', name: 'y', credentials: { project: 'p' } })
		).toThrow();
	});

	it('tests the connection, reporting what the provider said', async () => {
		const { ctx, account } = setup();
		await expect(adapters.testAccount(ctx, account.id)).resolves.toEqual({ ok: true });
		adapters.updateAccount(ctx, account.id, {
			credentials: { apiToken: 'revoked', project: 'lab' }
		});
		await expect(adapters.testAccount(ctx, account.id)).rejects.toThrow(
			'Fake lab: The API token was rejected'
		);
	});

	it('lists regions and sizes, GPUs included', async () => {
		const { ctx, account } = setup();
		expect(await adapters.regions(ctx, account.id)).toEqual([
			{ id: 'fake-1', name: 'Fake Region 1' }
		]);
		const sizes = await adapters.offers(ctx, account.id, 'fake-1');
		expect(sizes.find((o) => o.id === 'gpu')?.gpu).toEqual({
			model: 'NVIDIA L4',
			count: 1,
			vramGb: 24
		});
	});
});

describe('provisioning a node', () => {
	it('creates a machine that enrolls itself, linked to the account that made it', async () => {
		const { ctx, account } = setup();
		const started = await provision(ctx, account.id);
		expect(started.machine).toMatchObject({ name: 'gpu-1', status: 'provisioning' });

		const spec = created[0]!;
		expect(spec.userData).toContain(`--token '${spec.install.token}'`);

		// a machine that can only be handed a URL fetches the same user data from its seed
		const seedId = spec.seedUrl.match(/\/seed\/([^/]+)\/$/)![1]!;
		expect(spec.seedUrl).toBe(`http://localhost:5173/api/agent/v1/seed/${seedId}/`);
		expect(adapters.seedFile(ctx.db, ctx.secrets, seedId, 'user-data')).toBe(spec.userData);
		expect(adapters.seedFile(ctx.db, ctx.secrets, seedId, 'meta-data')).toBe(
			`instance-id: ${started.id}\nlocal-hostname: gpu-1\n`
		);
		expect(adapters.seedFile(ctx.db, ctx.secrets, seedId, 'vendor-data')).toBe('');
		expect(adapters.seedFile(ctx.db, ctx.secrets, seedId, 'secrets')).toBeNull();
		expect(adapters.seedFile(ctx.db, ctx.secrets, 'guessed', 'user-data')).toBeNull();
		const later = new Date(Date.now() + 2 * 3600_000);
		expect(adapters.seedFile(ctx.db, ctx.secrets, seedId, 'user-data', later)).toBeNull();
		expect(spec.install.url).toBe('http://localhost:5173');
		expect(adapters.provisioning(ctx)).toEqual([
			expect.objectContaining({
				name: 'gpu-1',
				machine: started.machine.id,
				offer: 'gpu',
				expired: false
			})
		]);
		expect(adapters.listAccounts(ctx)[0]!.nodes).toBe(1);

		// the machine boots and its agent joins; its seed, which held the token, goes
		join(ctx.db, spec.install.token, hello);
		expect(adapters.provisioning(ctx)).toEqual([]);
		expect(adapters.seedFile(ctx.db, ctx.secrets, seedId, 'user-data')).toBeNull();
		const node = nodes.list(ctx).find((n) => n.name === 'gpu-1')!;
		expect(node).toMatchObject({
			adapter: 'fake',
			account: { id: account.id, name: 'Fake lab' },
			gpus: [{ model: 'NVIDIA L4', vramMb: 23_034 }]
		});

		// an account with nodes can't go; removing the node destroys its machine
		expect(() => adapters.removeAccount(ctx, account.id)).toThrow('still has 1 node');
		await nodes.remove(ctx, node.id);
		expect(fake.machines.size).toBe(0);
		adapters.removeAccount(ctx, account.id);
		expect(adapters.listAccounts(ctx)).toEqual([]);
	});

	it('keeps the node when its machine cannot be destroyed', async () => {
		const { ctx, account } = setup();
		await provision(ctx, account.id);
		const joined = join(ctx.db, created[0]!.install.token, hello);
		fake.adapter.destroyNode = async () => {
			throw new AdapterError('The provider is down');
		};
		await expect(nodes.remove(ctx, joined.nodeId)).rejects.toThrow(
			"Couldn't destroy gpu-1's machine, so the node was kept. Fake lab: The provider is down"
		);
		expect(nodes.list(ctx).some((n) => n.id === joined.nodeId)).toBe(true);
	});

	it('cleans up the join token when the adapter fails, and cancels machines that never enroll', async () => {
		const { ctx, account } = setup();
		await expect(
			adapters.provision(
				ctx,
				{ account: account.id, name: 'big', region: 'fake-1', offer: 'huge' },
				'http://t.test'
			)
		).rejects.toThrow('Fake lab: No size huge in fake-1');
		expect(adapters.provisioning(ctx)).toEqual([]);
		// the name is free again
		const started = await provision(ctx, account.id, 'big');

		// an hour later the token is spent, but the machine is still there to destroy
		const later = new Date(Date.now() + 2 * 3600_000);
		expect(adapters.provisioning(ctx, later)[0]).toMatchObject({ name: 'big', expired: true });
		await adapters.cancelProvisioning(ctx, started.id);
		expect(fake.machines.size).toBe(0);
		expect(adapters.provisioning(ctx)).toEqual([]);
		await expect(adapters.cancelProvisioning(ctx, started.id)).rejects.toThrow('not found');
	});

	it('links a machine that enrolled before the adapter answered', async () => {
		const { ctx, account } = setup();
		const createNode = fake.adapter.createNode;
		fake.adapter.createNode = async (creds, spec) => {
			join(ctx.db, spec.install.token, hello);
			return createNode(creds, spec);
		};
		const started = await provision(ctx, account.id, 'quick');
		const node = ctx.db.select().from(nodeTable).where(eq(nodeTable.name, 'quick')).get()!;
		expect(node.providerNodeId).toBe(started.machine.id);
	});

	it('names nodes uniquely across enrolled nodes and pending machines', async () => {
		const { ctx, account } = setup();
		await provision(ctx, account.id, 'twin');
		await expect(provision(ctx, account.id, 'twin')).rejects.toThrow('already a node called twin');
		expect(fake.machines.size).toBe(1);
	});

	it('forgets an account with no nodes, and its tokens keep no link to it', async () => {
		const { ctx, account } = setup();
		const started = await provision(ctx, account.id);
		await adapters.cancelProvisioning(ctx, started.id);
		adapters.removeAccount(ctx, account.id);
		expect(
			ctx.db.select().from(adapterAccount).where(eq(adapterAccount.id, account.id)).get()
		).toBeUndefined();
	});
});
