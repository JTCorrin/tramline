import { fakeAdapter, FAKE_TOKEN } from '@tramline/adapter-sdk';
import type { AgentHello, ServiceConfigPatch } from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerAdapter } from '../adapters/registry';
import { node, nodeSpend, priceOffer } from '../db/schema';
import * as adapters from '../domain/adapters';
import * as changes from '../domain/changes';
import type { Ctx } from '../domain/context';
import * as environments from '../domain/environments';
import * as nodes from '../domain/nodes';
import * as projects from '../domain/projects';
import * as services from '../domain/services';
import { reconcile } from '../nodes/reconciler';
import { ensureLocalNode, join, recordHello } from '../nodes/registry';
import { grantInstallAdmin, seedCtx } from '../testing';
import { accrueSpend, environmentCosts, nodeSpentThisMonth, projectCosts } from './costs';

const fake = fakeAdapter();
registerAdapter({ ...fake.adapter, meta: { ...fake.adapter.meta, id: 'fake-costs' } } as never);

const hello = (cpus = 4, memoryMb = 8192): AgentHello => ({
	protocol: 1,
	agentVersion: 'test',
	hostname: 'box',
	os: 'linux',
	arch: 'x64',
	cpus,
	memoryMb,
	docker: { version: '27.0.0' }
});

function setup() {
	const ctx = grantInstallAdmin(seedCtx());
	ctx.settings = { ...ctx.settings, dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-costs-')) };
	const { node: local } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
	recordHello(ctx.db, local.id, hello());
	const project = projects.create(ctx, { name: 'Shop' });
	const [env] = environments.list(ctx, project.id);
	return { ctx, local, project, env: env! };
}

function addService(ctx: Ctx, projectId: string, envId: string, patch: ServiceConfigPatch) {
	const svc = services.create(ctx, {
		projectId,
		kind: 'image',
		source: { type: 'image', image: 'traefik/whoami' }
	});
	services.stageConfig(ctx, svc.id, envId, { build: { scan: 'off' }, ...patch });
	return svc;
}

function deployAll(ctx: Ctx, envId: string) {
	changes.deploy(ctx, envId);
	reconcile(ctx.db, ctx.settings);
}

describe('what services cost', () => {
	it('charges each service its part of the node, by what it reserves', async () => {
		const { ctx, local, project, env } = setup();
		const node = await nodes.update(ctx, local.id, { monthlyCost: 40 });
		expect(node.cost).toEqual({ monthly: 40, source: 'entered', spent: 0 });
		// a quarter of the CPU is more than an eighth of the memory
		const api = addService(ctx, project.id, env.id, {
			deploy: { cpuRequest: 1, memoryRequestMb: 1024 }
		});
		// a limit stands in for a missing request: half the memory
		const db = addService(ctx, project.id, env.id, { deploy: { memoryMb: 4096 } });
		const free = addService(ctx, project.id, env.id, {});
		deployAll(ctx, env.id);

		const costs = environmentCosts(ctx, env.id);
		expect(costs).toMatchObject({ environmentId: env.id, monthly: 30, complete: true });
		expect(costs.services.map((s) => [s.serviceId, s.monthly, s.unreserved])).toEqual([
			[db.id, 20, false],
			[api.id, 10, false],
			[free.id, 0, true]
		]);
		expect(costs.services[1]!.nodes).toEqual([
			{ nodeId: local.id, name: 'local', share: 0.25, monthly: 10 }
		]);

		// several replicas reserve several times over
		services.stageConfig(ctx, api.id, env.id, { deploy: { replicas: 3 } });
		deployAll(ctx, env.id);
		expect(
			environmentCosts(ctx, env.id).services.find((s) => s.serviceId === api.id)?.monthly
		).toBe(30);

		// going back to the provider's price, of which there is none here
		expect((await nodes.update(ctx, local.id, { monthlyCost: null })).cost).toEqual({
			monthly: null,
			source: null,
			spent: 0
		});
		expect(environmentCosts(ctx, env.id)).toMatchObject({ monthly: 0, complete: false });
	});

	it("prices a machine from its provider's size, and adds up a project", async () => {
		const { ctx, local, project, env } = setup();
		await nodes.update(ctx, local.id, { cordoned: true });
		const account = adapters.createAccount(ctx, {
			adapter: 'fake-costs',
			name: 'Cloud',
			credentials: { apiToken: FAKE_TOKEN, project: 'p' }
		});
		const created = nodes.createJoinToken(ctx, { name: 'cloud-1' }, 'http://tramline.test');
		const joined = join(ctx.db, created.token, hello(2, 4096));
		ctx.db
			.update(node)
			.set({ adapterAccountId: account.id, region: 'eu-1', offer: 'small' })
			.where(eq(node.id, joined.nodeId))
			.run();
		ctx.db
			.insert(priceOffer)
			.values({
				accountId: account.id,
				region: 'eu-1',
				offerId: 'small',
				name: 'small',
				vcpus: 2,
				memoryMb: 4096,
				arch: 'amd64',
				hourly: 0.02,
				fetchedAt: new Date()
			})
			.run();
		expect(nodes.list(ctx).find((n) => n.id === joined.nodeId)?.cost).toEqual({
			monthly: 14.6,
			source: 'provider',
			spent: 0
		});

		addService(ctx, project.id, env.id, { deploy: { cpuRequest: 1 } });
		deployAll(ctx, env.id);
		expect(environmentCosts(ctx, env.id).monthly).toBe(7.3);

		const staging = environments.create(ctx, { projectId: project.id, name: 'staging' });
		addService(ctx, project.id, staging.id, { deploy: { cpuRequest: 2 } });
		deployAll(ctx, staging.id);
		expect(projectCosts(ctx, project.id)).toMatchObject({
			projectId: project.id,
			complete: true,
			environments: [
				{ environmentId: env.id, monthly: 7.3 },
				{ environmentId: staging.id, name: 'staging' }
			]
		});
	});

	it("isn't shown to other organizations", () => {
		const { ctx, project, env } = setup();
		const other = seedCtx(ctx.db);
		expect(() => environmentCosts(other, env.id)).toThrow('Environment');
		expect(() => projectCosts(other, project.id)).toThrow('Project');
	});
});

describe('what has been spent', () => {
	const MIN = 60_000;

	it('adds up nodes and services as time passes, by month', async () => {
		const { ctx, local, project, env } = setup();
		// $1 an hour, and a quarter of it reserved
		await nodes.update(ctx, local.id, { monthlyCost: 730 });
		const api = addService(ctx, project.id, env.id, { deploy: { cpuRequest: 1 } });
		deployAll(ctx, env.id);

		const start = new Date('2026-10-31T23:00:00Z');
		for (let i = 0; i < 12; i++) {
			accrueSpend(
				ctx.db,
				new Date(start.getTime() + i * 10 * MIN),
				new Date(start.getTime() + (i + 1) * 10 * MIN)
			);
		}
		// an hour in October, an hour in November
		const nov = new Date('2026-11-01T12:00:00Z');
		expect(nodeSpentThisMonth(ctx.db, nov).get(local.id)).toBe(1);
		const costs = environmentCosts(ctx, env.id, nov);
		expect(costs.spent).toBe(0.25);
		expect(costs.services.find((s) => s.serviceId === api.id)?.spent).toBe(0.25);
		expect(projectCosts(ctx, project.id, nov)).toMatchObject({ spent: 0.25 });
		expect(
			ctx.db
				.select()
				.from(nodeSpend)
				.all()
				.map((r) => [r.day, Math.round(r.amount * 100) / 100])
		).toEqual([
			['2026-10-31', 1],
			['2026-11-01', 1]
		]);
	});

	it("doesn't count a long gap, and forgets after 400 days", async () => {
		const { ctx, local } = setup();
		await nodes.update(ctx, local.id, { monthlyCost: 730 });
		const at = new Date('2026-01-01T00:00:00Z');
		// stopped for five hours: ten minutes counted
		accrueSpend(ctx.db, at, new Date(at.getTime() + 5 * 60 * MIN));
		expect(ctx.db.select().from(nodeSpend).get()?.amount).toBeCloseTo(1 / 6, 6);
		// nothing for no time, or backwards
		accrueSpend(ctx.db, at, at);
		expect(ctx.db.select().from(nodeSpend).all()).toHaveLength(1);
		const later = new Date(at.getTime() + (401 * 24 + 1) * 60 * MIN);
		accrueSpend(ctx.db, new Date(later.getTime() - MIN), later);
		expect(
			ctx.db
				.select()
				.from(nodeSpend)
				.all()
				.map((r) => r.day)
		).toEqual(['2027-02-06']);
	});
});
