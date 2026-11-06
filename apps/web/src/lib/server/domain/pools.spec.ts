import { AdapterError, fakeAdapter, FAKE_TOKEN, type NodeSpec } from '@tramline/adapter-sdk';
import type { AgentHello, ServiceConfigPatch } from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerAdapter } from '../adapters/registry';
import { deployment, joinToken, node } from '../db/schema';
import { reconcile } from '../nodes/reconciler';
import { ensureLocalNode, join, recordHello, recordReport } from '../nodes/registry';
import { grantInstallAdmin, seedCtx, testSecrets } from '../testing';
import * as adapters from './adapters';
import * as changes from './changes';
import type { Ctx } from './context';
import * as environments from './environments';
import * as pools from './pools';
import * as projects from './projects';
import * as services from './services';

// one adapter on the registry, under its own id; each test sees its machines through `fake`
let fake = fakeAdapter();
let created: NodeSpec[] = [];
let failCreate: string | null = null;
type Creds = Parameters<typeof fake.adapter.validate>[0];
registerAdapter({
	...fake.adapter,
	meta: { ...fake.adapter.meta, id: 'fake-pools' },
	listOffers: (creds: Creds, region: string) => fake.adapter.listOffers(creds, region),
	listNodes: (creds: Creds) => fake.adapter.listNodes(creds),
	createNode: (creds: Creds, spec: NodeSpec) => {
		if (failCreate) throw new AdapterError(failCreate);
		return fake.adapter.createNode(creds, spec);
	},
	destroyNode: (creds: Creds, id: string) => fake.adapter.destroyNode(creds, id)
} as never);

beforeEach(() => {
	fake = fakeAdapter({ onCreate: (spec) => created.push(spec) });
	created = [];
	failCreate = null;
});

const hello = (memoryMb: number): AgentHello => ({
	protocol: 1,
	agentVersion: 'test',
	hostname: 'vm',
	os: 'linux',
	arch: 'amd64',
	cpus: 2,
	memoryMb,
	docker: { version: '27.0.0' }
});

/** An install whose only node, `local`, is too small for what the tests deploy. */
function setup() {
	const ctx = grantInstallAdmin(seedCtx());
	ctx.settings = { ...ctx.settings, dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-pools-')) };
	const { node: local } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
	recordHello(ctx.db, local.id, hello(1024));
	recordReport(ctx.db, local.id, { containers: [], revision: null });
	const account = adapters.createAccount(ctx, {
		adapter: 'fake-pools',
		name: 'Lab',
		credentials: { apiToken: FAKE_TOKEN, project: 'lab' }
	});
	const project = projects.create(ctx, { name: 'Shop' });
	const [env] = environments.list(ctx, project.id);
	return { ctx, account, project, env: env!, local };
}

const createPool = (
	ctx: Ctx,
	account: string,
	options: Partial<Parameters<typeof pools.create>[1]> = {}
) =>
	pools.create(
		ctx,
		{ name: 'web', account, region: 'fake-1', offer: 'small', maxNodes: 2, ...options },
		'http://tramline.test'
	);

function deploy(ctx: Ctx, projectId: string, envId: string, patch: ServiceConfigPatch = {}) {
	const svc = services.create(ctx, {
		projectId,
		kind: 'image',
		source: { type: 'image', image: 'traefik/whoami' }
	});
	services.stageConfig(ctx, svc.id, envId, {
		build: { scan: 'off' },
		deploy: { memoryMb: 2048 },
		...patch
	});
	// a new service is staged in every environment; this deploys only `envId`'s changes
	const dep = changes.deploy(ctx, envId).find((d) => d.serviceId === svc.id);
	reconcile(ctx.db, ctx.settings);
	return {
		svc,
		row: () => ctx.db.select().from(deployment).where(eq(deployment.id, dep!.id)).get()!
	};
}

/** The machine the adapter created enrolls, as its agent would. */
function enroll(ctx: Ctx, spec: NodeSpec) {
	const joined = join(ctx.db, spec.install.token, hello(4096));
	recordReport(ctx.db, joined.nodeId, { containers: [], revision: null });
	return ctx.db.select().from(node).where(eq(node.id, joined.nodeId)).get()!;
}

const later = (seconds: number) => Date.now() + seconds * 1000;
const scale = (ctx: Ctx, at: number) => pools.autoscale(ctx.db, testSecrets, ctx.settings, at);

describe('node pools', () => {
	it('adds a machine for work that has nowhere to go, and removes it once idle', async () => {
		const { ctx, account, project, env } = setup();
		const pool = await createPool(ctx, account.id);
		expect(pool).toMatchObject({
			offer: { vcpus: 2, memoryMb: 4096, hourly: 0.01 },
			monthly: { now: 0, max: 14.6 },
			nodes: [],
			provisioning: 0
		});

		const { svc, row } = deploy(ctx, project.id, env.id);
		expect(row()).toMatchObject({
			status: 'queued',
			message: 'Waiting for a node with 2048 MB of memory free'
		});

		// not before the scheduler has had its go
		await scale(ctx, Date.now());
		expect(created).toHaveLength(0);

		await scale(ctx, later(20));
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({
			region: 'fake-1',
			offer: 'small',
			name: expect.stringMatching(/^web-[0-9a-f]{4}$/)
		});
		expect(pools.list(ctx)[0]).toMatchObject({
			provisioning: 1,
			activity: `Adding ${created[0]!.name} for 1 waiting deployment`
		});

		// one at a time: nothing more while that one enrolls
		await scale(ctx, later(40));
		expect(created).toHaveLength(1);

		const machine = enroll(ctx, created[0]!);
		expect(machine.poolId).toBe(pool.id);
		reconcile(ctx.db, ctx.settings);
		expect(row()).toMatchObject({ status: 'deploying', nodeId: machine.id });
		await scale(ctx, later(60));
		expect(created).toHaveLength(1);

		services.remove(ctx, svc.id);
		reconcile(ctx.db, ctx.settings);
		await scale(ctx, later(120));
		expect(pools.list(ctx)[0]!.nodes[0]!.idleSince).not.toBeNull();
		// not idle long enough yet
		await scale(ctx, later(120 + 14 * 60));
		expect(fake.machines.size).toBe(1);
		await scale(ctx, later(120 + 16 * 60));
		expect(fake.machines.size).toBe(0);
		expect(ctx.db.select().from(node).where(eq(node.id, machine.id)).get()).toBeUndefined();
		expect(pools.list(ctx)[0]).toMatchObject({
			nodes: [],
			activity: `Removed ${machine.name}, which was idle`
		});
	});

	it('keeps its minimum, and never grows past its maximum or spend cap', async () => {
		const { ctx, account, project, env } = setup();
		await createPool(ctx, account.id, { minNodes: 1, maxNodes: 1 });
		await scale(ctx, later(1));
		expect(created).toHaveLength(1);
		enroll(ctx, created[0]!);
		// idle for days, it stays: it's the minimum
		await scale(ctx, later(3 * 24 * 3600));
		expect(fake.machines.size).toBe(1);

		// full: the one machine has room for one 3000 MB service, and the maximum is 1
		deploy(ctx, project.id, env.id, { deploy: { memoryMb: 3000 } });
		const second = deploy(ctx, project.id, env.id, { deploy: { memoryMb: 3000 } });
		reconcile(ctx.db, ctx.settings);
		expect(second.row().status).toBe('queued');
		await scale(ctx, later(3 * 24 * 3600 + 60));
		expect(created).toHaveLength(1);

		// $5 a month doesn't cover one machine at $0.01 an hour
		const capped = await pools.create(
			ctx,
			{ name: 'capped', account: account.id, region: 'fake-1', offer: 'small', monthlyCap: 5 },
			'http://tramline.test'
		);
		await scale(ctx, later(3 * 24 * 3600 + 120));
		expect(created).toHaveLength(1);
		pools.update(ctx, capped.id, { monthlyCap: 10 });
		await scale(ctx, later(3 * 24 * 3600 + 180));
		expect(created.map((c) => c.name)).toEqual([
			expect.stringMatching(/^web-/),
			expect.stringMatching(/^capped-/)
		]);
	});

	it("only grows for work that fits its size, isn't tied to another node, and is in its environment", async () => {
		const { ctx, account, project, env } = setup();
		const staging = environments.create(ctx, { projectId: project.id, name: 'staging' });
		const pool = await createPool(ctx, account.id, { environmentId: staging.id });
		expect(pool.environment).toMatchObject({ name: 'staging', project: 'Shop' });

		// too big for a 4 GB machine
		deploy(ctx, project.id, staging.id, { deploy: { memoryMb: 8192 } });
		// another environment
		const prod = deploy(ctx, project.id, env.id);
		await scale(ctx, later(20));
		expect(created).toHaveLength(0);

		const fits = deploy(ctx, project.id, staging.id);
		await scale(ctx, later(40));
		expect(created).toHaveLength(1);
		const machine = enroll(ctx, created[0]!);
		reconcile(ctx.db, ctx.settings);
		expect(fits.row().nodeId).toBe(machine.id);
		// production's service can't use staging's machine, though it has room
		expect(prod.row()).toMatchObject({
			status: 'queued',
			message: 'Waiting for a node with 2048 MB of memory free'
		});
	});

	it('backs off after a provider error, and destroys machines that never enroll', async () => {
		const { ctx, account, project, env } = setup();
		await createPool(ctx, account.id);
		deploy(ctx, project.id, env.id);
		failCreate = 'Quota exceeded';
		await scale(ctx, later(20));
		expect(pools.list(ctx)[0]).toMatchObject({ error: 'Lab: Quota exceeded' });
		failCreate = null;
		await scale(ctx, later(60));
		expect(created).toHaveLength(0);
		await scale(ctx, later(20 + 6 * 60));
		expect(created).toHaveLength(1);

		// an hour on, it never enrolled
		await scale(ctx, later(20 + 6 * 60 + 3601));
		expect(fake.machines.size).toBe(0);
		expect(pools.list(ctx)[0]!.error).toMatch(/didn't enroll within an hour/);
	});

	it('removing it drains its machines, then destroys them, and refuses while one holds data', async () => {
		const { ctx, account, project, env, local } = setup();
		const pool = await createPool(ctx, account.id);
		const { row } = deploy(ctx, project.id, env.id);
		await scale(ctx, later(20));
		const machine = enroll(ctx, created[0]!);
		reconcile(ctx.db, ctx.settings);
		expect(row().nodeId).toBe(machine.id);
		// room for it elsewhere once it moves
		recordHello(ctx.db, local.id, hello(8192));

		const removing = await pools.remove(ctx, pool.id);
		expect(removing).toMatchObject({ removing: true, maxNodes: 0 });
		expect(fake.machines.size).toBe(1);
		// the moved copy runs on local; the old deployment stops
		ctx.db.update(deployment).set({ status: 'removed' }).where(eq(deployment.id, row().id)).run();
		await scale(ctx, later(40));
		expect(fake.machines.size).toBe(0);
		expect(pools.list(ctx)).toEqual([]);

		const kept = await createPool(ctx, account.id, { name: 'db' });
		recordHello(ctx.db, local.id, hello(1024));
		deploy(ctx, project.id, env.id, { volume: { mountPath: '/data' } });
		await scale(ctx, later(60));
		const holder = enroll(ctx, created[1]!);
		reconcile(ctx.db, ctx.settings);
		expect(holder.poolId).toBe(kept.id);
		await expect(pools.remove(ctx, kept.id)).rejects.toThrow(/holds a service's data/);
		expect(fake.machines.size).toBe(1);
	});

	it('is for install admins, and checks the offer and limits', async () => {
		const { ctx, account } = setup();
		const outsider = seedCtx(ctx.db);
		expect(() => pools.list(outsider)).toThrow("Only this install's admins");
		await expect(createPool(ctx, account.id, { offer: 'huge' })).rejects.toThrow("isn't offered");
		await expect(createPool(ctx, account.id, { minNodes: 3, maxNodes: 1 })).rejects.toThrow();
		const pool = await createPool(ctx, account.id);
		await expect(createPool(ctx, account.id)).rejects.toThrow('already a node pool called web');
		expect(() => pools.update(ctx, pool.id, { minNodes: 5 })).toThrow('minimum is more');
		expect(() => adapters.removeAccount(ctx, account.id)).toThrow('node pool web uses Lab');
	});
});

describe('leftover machines', () => {
	it('lists tagged machines no node accounts for, and destroys only those', async () => {
		const { ctx, account, project, env } = setup();
		await createPool(ctx, account.id);
		deploy(ctx, project.id, env.id);
		await scale(ctx, later(20));
		const stray = await fake.adapter.createNode({ apiToken: FAKE_TOKEN, project: 'lab' } as never, {
			...created[0]!,
			name: 'stray'
		});

		expect((await adapters.leftovers(ctx, account.id)).map((m) => m.name)).toEqual(['stray']);
		const pending = ctx.db
			.select()
			.from(joinToken)
			.where(eq(joinToken.poolId, pools.list(ctx)[0]!.id))
			.get()!;
		await expect(
			adapters.destroyLeftover(ctx, account.id, pending.providerNodeId!)
		).rejects.toThrow('not found');
		await adapters.destroyLeftover(ctx, account.id, stray.id);
		expect([...fake.machines.keys()]).toEqual([pending.providerNodeId]);
	});
});
