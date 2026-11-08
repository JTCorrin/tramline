import type { AgentHello, GpuRequest, ServiceConfigPatch } from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deployment, node } from '../db/schema';
import * as changes from '../domain/changes';
import type { Ctx } from '../domain/context';
import * as deployments from '../domain/deployments';
import * as environments from '../domain/environments';
import * as nodes from '../domain/nodes';
import * as projects from '../domain/projects';
import * as services from '../domain/services';
import { grantInstallAdmin, seedCtx, testSecrets } from '../testing';
import { buildDesiredState, containerName } from './desired';
import { describeGpus, gpuMatches, offerFits } from './gpus';
import { reconcile } from './reconciler';
import { ensureLocalNode, join, recordHello, recordReport } from './registry';

const hello = (gpus: string[] = [], gpuRuntime = gpus.length > 0): AgentHello => ({
	protocol: 1,
	agentVersion: 'test',
	hostname: 'box',
	os: 'linux',
	arch: 'amd64',
	cpus: 8,
	memoryMb: 32_768,
	docker: { version: '27.0.0' },
	gpus: gpus.map((model) => ({ model, vramMb: null })),
	gpuRuntime
});

const A10 = 'NVIDIA A10';
const H100 = 'NVIDIA H100 80GB HBM3';

function setup() {
	const ctx = grantInstallAdmin(seedCtx());
	ctx.settings = { ...ctx.settings, dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-gpus-')) };
	const { node: local } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
	recordHello(ctx.db, local.id, hello());
	const project = projects.create(ctx, { name: 'Lab' });
	const [env] = environments.list(ctx, project.id);
	return { ctx, local, project, env: env! };
}

/** A machine with GPUs, enrolled as its agent would; `vramGb` as the provider's size says. */
function gpuNode(ctx: Ctx, name: string, gpus: string[], vramGb: number | null = null) {
	const created = nodes.createJoinToken(ctx, { name }, 'http://tramline.test');
	const joined = join(ctx.db, created.token, hello(gpus));
	if (vramGb) {
		ctx.db
			.update(node)
			.set({ offerGpu: { model: gpus[0]!, count: gpus.length, vramGb } })
			.where(eq(node.id, joined.nodeId))
			.run();
	}
	return ctx.db.select().from(node).where(eq(node.id, joined.nodeId)).get()!;
}

function addService(ctx: Ctx, projectId: string, envId: string, patch: ServiceConfigPatch) {
	const svc = services.create(ctx, {
		projectId,
		kind: 'image',
		source: { type: 'image', image: 'vllm/vllm-openai' }
	});
	services.stageConfig(ctx, svc.id, envId, { build: { scan: 'off' }, ...patch });
	return svc;
}

const gpus = (request: Partial<GpuRequest> = {}): ServiceConfigPatch => ({
	deploy: { gpus: { count: 1, model: null, minVramGb: null, ...request } }
});

const row = (ctx: Ctx, id: string) =>
	ctx.db.select().from(deployment).where(eq(deployment.id, id)).get()!;

/** What a node's agent is told to run: each container's deployment and GPUs. */
const desired = (ctx: Ctx, nodeId: string) =>
	buildDesiredState(ctx.db, testSecrets, ctx.settings, nodeId).containers.map((c) => ({
		deploymentId: c.deploymentId,
		gpus: c.gpus
	}));

/** The node's agent reports these deployments' first replicas running. */
const running = (ctx: Ctx, nodeId: string, ids: string[]) =>
	recordReport(ctx.db, nodeId, {
		revision: null,
		containers: ids.map((id) => ({
			name: containerName(id, 0),
			deploymentId: id,
			replica: 0,
			state: 'running' as const,
			healthy: null,
			exitCode: null,
			restartCount: 0,
			error: null,
			startedAt: new Date(Date.now() - 60_000).toISOString()
		}))
	});

describe('GPU placement', () => {
	it('runs a GPU service on a node with a free GPU, and gives each replica its own', () => {
		const { ctx, project, env, local } = setup();
		const box = gpuNode(ctx, 'gpu-1', [A10, A10]);
		addService(ctx, project.id, env.id, gpus());
		addService(ctx, project.id, env.id, gpus());
		// work without GPUs keeps off the GPU node while another has room
		addService(ctx, project.id, env.id, {});
		const created = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);

		const [a, b, plain] = created.map((d) => row(ctx, d.id));
		expect([a!.nodeId, b!.nodeId, plain!.nodeId]).toEqual([box.id, box.id, local.id]);
		expect([a!.replicaGpus, b!.replicaGpus]).toEqual([[['0']], [['1']]]);
		expect(desired(ctx, box.id)).toEqual([
			{ deploymentId: a!.id, gpus: ['0'] },
			{ deploymentId: b!.id, gpus: ['1'] }
		]);
		// containers without GPUs don't carry the field, so their spec hash doesn't change
		expect(
			buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).containers[0]
		).not.toHaveProperty('gpus');

		// the node is full: a third GPU service waits, and says for what
		const third = addService(ctx, project.id, env.id, gpus({ model: 'A10' }));
		const [queued] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		expect(row(ctx, queued!.id)).toMatchObject({
			serviceId: third.id,
			status: 'queued',
			message: 'Waiting for a node with 1 A10 GPU free'
		});
		expect(nodes.list(ctx).find((n) => n.id === box.id)).toMatchObject({
			gpuRuntime: true,
			allocatedGpus: 2
		});
	});

	it('matches the model and memory asked for, and says why nothing fits', () => {
		const { ctx, project, env } = setup();
		gpuNode(ctx, 'a10', [A10], 24);
		const h100 = gpuNode(ctx, 'h100', [H100], 80);
		addService(ctx, project.id, env.id, gpus({ minVramGb: 40 }));
		const [big] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		expect(row(ctx, big!.id).nodeId).toBe(h100.id);

		addService(ctx, project.id, env.id, gpus({ count: 2, model: 'h100' }));
		const [two] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		expect(row(ctx, two!.id)).toMatchObject({
			status: 'queued',
			message: 'Waiting for a node with 2 h100 GPUs'
		});
	});

	it("won't place GPU work where Docker can't hand GPUs to containers", () => {
		const { ctx, project, env } = setup();
		const created = nodes.createJoinToken(ctx, { name: 'no-toolkit' }, 'http://tramline.test');
		join(ctx.db, created.token, hello([A10], false));
		addService(ctx, project.id, env.id, gpus());
		const [dep] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		expect(row(ctx, dep!.id)).toMatchObject({
			status: 'queued',
			message: expect.stringMatching(/no-toolkit has GPUs, but Docker there can't hand them/)
		});
	});

	it('swaps a redeploy when a GPU is spare, and stops the old one first when not', () => {
		const { ctx, project, env } = setup();
		const box = gpuNode(ctx, 'gpu-1', [A10, A10]);
		const svc = addService(ctx, project.id, env.id, gpus());
		const [first] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		running(ctx, box.id, [first!.id]);
		reconcile(ctx.db, ctx.settings);
		expect(row(ctx, first!.id).status).toBe('active');

		// the second GPU is free, so the new deployment starts beside the old one
		const second = deployments.redeploy(ctx, first!.id);
		reconcile(ctx.db, ctx.settings);
		expect(row(ctx, second.id).replicaGpus).toEqual([['1']]);
		expect(desired(ctx, box.id)).toEqual([
			{ deploymentId: first!.id, gpus: ['0'] },
			{ deploymentId: second.id, gpus: ['1'] }
		]);
		running(ctx, box.id, [first!.id, second.id]);
		reconcile(ctx.db, ctx.settings);
		expect(row(ctx, second.id).status).toBe('active');
		expect(row(ctx, first!.id).status).toBe('removed');

		// another GPU service takes GPU 0, so the next redeploy can only reuse GPU 1
		addService(ctx, project.id, env.id, gpus());
		const [neighbour] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		expect(row(ctx, neighbour!.id).replicaGpus).toEqual([['0']]);
		running(ctx, box.id, [second.id, neighbour!.id]);
		reconcile(ctx.db, ctx.settings);

		const third = deployments.redeploy(ctx, second.id);
		reconcile(ctx.db, ctx.settings);
		expect(row(ctx, third.id)).toMatchObject({
			serviceId: svc.id,
			replicaGpus: [['1']],
			message: 'Waiting for the previous deployment to stop'
		});
		expect(desired(ctx, box.id).map((c) => c.deploymentId)).toEqual([neighbour!.id]);

		// once the old one is gone, the new one starts on its GPU
		running(ctx, box.id, [neighbour!.id]);
		reconcile(ctx.db, ctx.settings);
		expect(desired(ctx, box.id)).toContainEqual({ deploymentId: third.id, gpus: ['1'] });
	});
});

describe('GPU matching', () => {
	const req = (r: Partial<GpuRequest>): GpuRequest => ({
		count: 1,
		model: null,
		minVramGb: null,
		...r
	});

	it('matches part of the model name, and memory only when it is known', () => {
		expect(gpuMatches({ model: H100, vramGb: 80 }, req({ model: 'h100 80gb' }))).toBe(true);
		expect(gpuMatches({ model: A10, vramGb: 24 }, req({ model: 'A100' }))).toBe(false);
		expect(gpuMatches({ model: A10, vramGb: null }, req({ minVramGb: 16 }))).toBe(false);
		expect(gpuMatches({ model: A10, vramGb: null }, req({}))).toBe(true);
	});

	it('only grows a pool of GPU machines for work that fits them', () => {
		const offer = { model: 'NVIDIA A100', count: 2, vramGb: 40 };
		expect(offerFits(offer, req({ count: 2 }))).toBe(true);
		expect(offerFits(offer, req({ count: 4 }))).toBe(false);
		expect(offerFits(null, req({}))).toBe(false);
		expect(offerFits(null, null)).toBe(true);
	});

	it('says what is asked for', () => {
		expect(describeGpus(req({}))).toBe('1 GPU');
		expect(describeGpus(req({ count: 2, model: 'A100', minVramGb: 80 }))).toBe(
			'2 A100 GPUs with 80 GB each'
		);
	});
});
