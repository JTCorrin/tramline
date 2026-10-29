import type { AgentHello, ContainerSample, NodeSample } from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { alert, containerMetric, deployment, node, nodeMetric } from '../db/schema';
import {
	evaluateAlerts,
	notifyAlerts,
	OFFLINE_AFTER_MS,
	pruneAlerts,
	runMetricsJobs
} from '../metrics/alerts';
import { HOUR, MINUTE, pruneMetrics, recordMetrics, rollUp } from '../metrics/store';
import { reconcile } from '../nodes/reconciler';
import { ensureLocalNode, recordHello } from '../nodes/registry';
import { grantInstallAdmin, seedCtx } from '../testing';
import * as changes from './changes';
import * as environments from './environments';
import * as metrics from './metrics';
import * as projects from './projects';
import * as services from './services';

const hello: AgentHello = {
	protocol: 1,
	agentVersion: 'test',
	hostname: 'box',
	os: 'linux',
	arch: 'arm64',
	cpus: 4,
	memoryMb: 8192,
	docker: { version: '27.0.0' }
};

/** A fixed minute boundary, so buckets are predictable. */
const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);

/** A service with a 512 MB limit, deployed on the local node. */
function setup() {
	const ctx = grantInstallAdmin(seedCtx());
	ctx.settings = {
		...ctx.settings,
		dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-metrics-'))
	};
	const { node: local } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
	recordHello(ctx.db, local.id, hello);
	const project = projects.create(ctx, { name: 'Shop' });
	const env = environments.list(ctx, project.id)[0]!;
	const svc = services.create(ctx, {
		projectId: project.id,
		kind: 'image',
		source: { type: 'image', image: 'redis:7' }
	});
	services.stageConfig(ctx, svc.id, env.id, { build: { scan: 'off' }, deploy: { memoryMb: 512 } });
	const [created] = changes.deploy(ctx, env.id);
	reconcile(ctx.db, ctx.settings);
	const dep = ctx.db.select().from(deployment).where(eq(deployment.id, created!.id)).get()!;
	ctx.db.update(deployment).set({ status: 'active' }).where(eq(deployment.id, dep.id)).run();
	return { ctx, local, env, svc, dep };
}

const nodeSample = (overrides: Partial<NodeSample> = {}): NodeSample => ({
	cpuPercent: 20,
	memoryUsedMb: 4000,
	memoryTotalMb: 8000,
	diskUsedMb: 50_000,
	diskTotalMb: 100_000,
	...overrides
});

const containerSample = (deploymentId: string, overrides: Partial<ContainerSample> = {}) => ({
	deploymentId,
	replica: 0,
	cpuPercent: 50,
	memoryMb: 200,
	memoryLimitMb: 512,
	rxBytes: 6000,
	txBytes: 600,
	...overrides
});

const batch = (node: NodeSample | null, containers: ContainerSample[] = []) => ({
	at: new Date(T0).toISOString(),
	node,
	containers
});

describe('recording metrics', () => {
	it('folds samples into minute buckets, and sums a service over its replicas', () => {
		const { ctx, local, env, svc, dep } = setup();
		recordMetrics(ctx.db, local.id, batch(nodeSample(), [containerSample(dep.id)]), T0 + 5_000);
		recordMetrics(
			ctx.db,
			local.id,
			batch(nodeSample({ cpuPercent: 40, diskUsedMb: null }), [
				containerSample(dep.id, { cpuPercent: 150, memoryMb: 300 }),
				containerSample(dep.id, { replica: 1, cpuPercent: 10, memoryMb: 100 })
			]),
			T0 + 20_000
		);
		// the next minute
		recordMetrics(ctx.db, local.id, batch(nodeSample()), T0 + 65_000);

		const series = metrics.serviceMetrics(ctx, svc.id, env.id, null);
		expect(series).toMatchObject({ range: '1h', step: 60 });
		// replica 0 averaged 100% over two samples and replica 1 10%; memory likewise
		expect(series.points).toEqual([
			{
				at: new Date(T0).toISOString(),
				cpuPercent: 110,
				cpuMaxPercent: 160,
				memoryMb: 350,
				memoryMaxMb: 400,
				memoryLimitMb: 1024,
				rxBytesPerSecond: 300,
				txBytesPerSecond: 30
			}
		]);

		const nodeSeries = metrics.nodeMetrics(ctx, local.id, '6h');
		expect(nodeSeries.points).toEqual([
			{
				at: new Date(T0).toISOString(),
				cpuPercent: 30,
				cpuMaxPercent: 40,
				memoryUsedMb: 4000,
				memoryTotalMb: 8000,
				// a sample without a disk reading keeps the one before
				diskUsedMb: 50_000,
				diskTotalMb: 100_000
			},
			expect.objectContaining({ at: new Date(T0 + 60_000).toISOString() })
		]);
	});

	it("ignores samples for deployments that aren't on the reporting node", () => {
		const { ctx, local, dep } = setup();
		const other = ctx.db
			.insert(node)
			.values({ id: 'node_other', name: 'other', tokenHash: 'x' })
			.returning()
			.get();
		recordMetrics(ctx.db, other.id, batch(null, [containerSample(dep.id)]), T0);
		recordMetrics(ctx.db, local.id, batch(null, [containerSample('dep_unknown')]), T0);
		expect(ctx.db.select().from(containerMetric).all()).toEqual([]);
	});

	it('checks access, and the range', () => {
		const { ctx, env, svc, local } = setup();
		const stranger = seedCtx(ctx.db);
		expect(() => metrics.serviceMetrics(stranger, svc.id, env.id, '1h')).toThrow(
			'Service not found'
		);
		expect(() => metrics.serviceMetrics(ctx, svc.id, env.id, '2y')).toThrow(
			'range must be one of 1h, 6h, 24h, 7d, 30d'
		);
		expect(() => metrics.nodeMetrics(ctx, 'node_nope', '1h')).toThrow('Node not found');
		// nodes are shared by the install
		expect(metrics.nodeMetrics(stranger, local.id, '1h').points).toEqual([]);
	});
});

describe('rollups and retention', () => {
	it('rolls minutes up into hours, idempotently, and serves long ranges from them', () => {
		const { ctx, local, env, svc, dep } = setup();
		for (let minute = 0; minute < 3; minute++) {
			recordMetrics(
				ctx.db,
				local.id,
				batch(nodeSample({ cpuPercent: 10 * (minute + 1) }), [
					containerSample(dep.id, { memoryMb: 100 * (minute + 1) })
				]),
				T0 + minute * 60_000
			);
		}
		rollUp(ctx.db, T0 + 3 * 60_000);
		rollUp(ctx.db, T0 + 3 * 60_000);
		const hours = ctx.db.select().from(nodeMetric).where(eq(nodeMetric.step, HOUR)).all();
		expect(hours).toEqual([
			expect.objectContaining({ bucket: T0, samples: 3, cpuSum: 60, cpuMax: 30 })
		]);
		const week = metrics.serviceMetrics(ctx, svc.id, env.id, '7d');
		expect(week).toMatchObject({ step: 3600 });
		expect(week.points).toEqual([
			expect.objectContaining({ memoryMb: 200, memoryMaxMb: 300, rxBytesPerSecond: 5 })
		]);
		expect(metrics.nodeMetrics(ctx, local.id, '30d').points[0]).toMatchObject({
			cpuPercent: 20
		});
	});

	it('keeps minutes for two days and hours for a month', () => {
		const { ctx, local, dep } = setup();
		const day = 86_400_000;
		for (const at of [T0 - 3 * day, T0 - 40 * day, T0]) {
			recordMetrics(ctx.db, local.id, batch(nodeSample(), [containerSample(dep.id)]), at);
			rollUp(ctx.db, at);
		}
		pruneMetrics(ctx.db, T0);
		const kept = (table: typeof nodeMetric | typeof containerMetric) =>
			ctx.db
				.select({ step: table.step, bucket: table.bucket })
				.from(table)
				.all()
				.map((r) => `${r.step}@${(T0 - r.bucket) / day}d`)
				.sort();
		expect(kept(nodeMetric)).toEqual(['3600@0d', '3600@3d', '60@0d']);
		expect(kept(containerMetric)).toEqual(['3600@0d', '3600@3d', '60@0d']);
	});
});

describe('alerts', () => {
	it('opens when a node goes quiet, and resolves when it reports again', () => {
		const { ctx, local } = setup();
		ctx.db
			.update(node)
			.set({ lastSeenAt: new Date(T0 - OFFLINE_AFTER_MS - 60_000) })
			.where(eq(node.id, local.id))
			.run();
		const first = evaluateAlerts(ctx.db, T0);
		expect(first.opened).toEqual([
			expect.objectContaining({
				kind: 'node_offline',
				nodeId: local.id,
				message: 'local stopped reporting 3 minutes ago',
				resolvedAt: null
			})
		]);
		// still offline: nothing new
		expect(evaluateAlerts(ctx.db, T0 + 60_000)).toEqual({ opened: [], resolved: [] });

		ctx.db
			.update(node)
			.set({ lastSeenAt: new Date(T0 + 90_000) })
			.where(eq(node.id, local.id))
			.run();
		const back = evaluateAlerts(ctx.db, T0 + 120_000);
		expect(back.resolved).toEqual([
			expect.objectContaining({
				kind: 'node_offline',
				resolvedAt: new Date(T0 + 120_000).toISOString()
			})
		]);
	});

	it('opens disk and memory alerts at 90%, and clears them below 85%', () => {
		const { ctx, local, dep } = setup();
		const fill = (at: number, memoryUsedMb: number, diskUsedMb: number, serviceMb: number) => {
			for (let minute = 0; minute < 5; minute++) {
				recordMetrics(
					ctx.db,
					local.id,
					batch(nodeSample({ memoryUsedMb, diskUsedMb }), [
						containerSample(dep.id, { memoryMb: serviceMb })
					]),
					at + minute * 60_000
				);
			}
			return at + 5 * 60_000 - 1;
		};
		const now = fill(T0, 7400, 93_000, 480);
		ctx.db
			.update(node)
			.set({ lastSeenAt: new Date(now) })
			.where(eq(node.id, local.id))
			.run();
		const opened = evaluateAlerts(ctx.db, now).opened;
		expect(opened.map((a) => a.message).sort()).toEqual([
			'Disk on local is 93% full (90.8 GB of 97.7 GB)',
			'local is using 93% of its memory (7.2 GB of 7.8 GB)',
			'redis in production is using 94% of its memory limit (480 of 512 MB)'
		]);

		// 87% is below the line to open, but not low enough to clear
		const later = fill(now + 1, 6960, 87_000, 445);
		ctx.db
			.update(node)
			.set({ lastSeenAt: new Date(later) })
			.where(eq(node.id, local.id))
			.run();
		expect(evaluateAlerts(ctx.db, later)).toEqual({ opened: [], resolved: [] });

		const calm = fill(later + 1, 4000, 50_000, 200);
		ctx.db
			.update(node)
			.set({ lastSeenAt: new Date(calm) })
			.where(eq(node.id, local.id))
			.run();
		expect(evaluateAlerts(ctx.db, calm).resolved).toHaveLength(3);
	});

	it('waits for a few minutes of data before judging memory', () => {
		const { ctx, local, dep } = setup();
		recordMetrics(
			ctx.db,
			local.id,
			batch(nodeSample({ memoryUsedMb: 7900 }), [containerSample(dep.id, { memoryMb: 510 })]),
			T0
		);
		ctx.db
			.update(node)
			.set({ lastSeenAt: new Date(T0) })
			.where(eq(node.id, local.id))
			.run();
		expect(evaluateAlerts(ctx.db, T0).opened).toEqual([]);
	});

	it("lists the install's node alerts, and only this organization's service alerts", () => {
		const { ctx, local, svc, env } = setup();
		const insert = (id: string, values: Partial<typeof alert.$inferInsert>) =>
			ctx.db
				.insert(alert)
				.values({ id, kind: 'node_disk', message: id, openedAt: new Date(T0), ...values })
				.run();
		insert('alr_node', { nodeId: local.id });
		insert('alr_service', { kind: 'service_memory', serviceId: svc.id, environmentId: env.id });
		insert('alr_old', { nodeId: local.id, resolvedAt: new Date(T0 - 2 * 86_400_000) });
		insert('alr_recent', { nodeId: local.id, resolvedAt: new Date(T0 - 3600_000) });
		expect(
			metrics
				.listAlerts(ctx, T0)
				.map((a) => a.id)
				.sort()
		).toEqual(['alr_node', 'alr_recent', 'alr_service']);
		const stranger = seedCtx(ctx.db);
		expect(
			metrics
				.listAlerts(stranger, T0)
				.map((a) => a.id)
				.sort()
		).toEqual(['alr_node', 'alr_recent']);

		pruneAlerts(ctx.db, T0 + 29 * 86_400_000);
		expect(
			ctx.db
				.select()
				.from(alert)
				.all()
				.map((a) => a.id)
		).not.toContain('alr_old');
		expect(
			ctx.db
				.select()
				.from(alert)
				.all()
				.map((a) => a.id)
		).toContain('alr_recent');
		pruneAlerts(ctx.db, T0 + 31 * 86_400_000);
		expect(
			ctx.db
				.select()
				.from(alert)
				.all()
				.map((a) => a.id)
		).not.toContain('alr_recent');
	});

	it('posts changes to the webhook, and survives one that fails', async () => {
		const { ctx, local } = setup();
		ctx.db
			.update(node)
			.set({ lastSeenAt: new Date(T0 - OFFLINE_AFTER_MS) })
			.where(eq(node.id, local.id))
			.run();
		const changed = evaluateAlerts(ctx.db, T0);
		const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
		await notifyAlerts('https://hooks.test/x', changed, fetcher as unknown as typeof fetch);
		const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://hooks.test/x');
		expect(JSON.parse(init.body as string)).toMatchObject({
			status: 'opened',
			text: '🔴 local stopped reporting 2 minutes ago',
			content: '🔴 local stopped reporting 2 minutes ago',
			alert: { kind: 'node_offline' }
		});

		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		await notifyAlerts(
			'https://hooks.test/x',
			{ opened: [], resolved: changed.opened },
			(async () => new Response(null, { status: 500 })) as unknown as typeof fetch
		);
		await notifyAlerts('https://hooks.test/x', changed, (async () => {
			throw new Error('ECONNREFUSED');
		}) as unknown as typeof fetch);
		expect(error.mock.calls.map((c) => c.join(' '))).toEqual([
			'[alerts] the webhook answered 500',
			'[alerts] the webhook failed: ECONNREFUSED'
		]);
		error.mockRestore();
		// no webhook, nothing to post
		await notifyAlerts(undefined, changed, fetcher as unknown as typeof fetch);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('runs the minute job end to end', async () => {
		const { ctx, local } = setup();
		recordMetrics(ctx.db, local.id, batch(nodeSample({ diskUsedMb: 99_000 })), T0);
		ctx.db
			.update(node)
			.set({ lastSeenAt: new Date(T0) })
			.where(eq(node.id, local.id))
			.run();
		await runMetricsJobs(ctx.db, undefined, T0 + 1000);
		expect(ctx.db.select().from(nodeMetric).where(eq(nodeMetric.step, HOUR)).all()).toHaveLength(1);
		expect(ctx.db.select().from(alert).all()).toEqual([
			expect.objectContaining({ kind: 'node_disk', resolvedAt: null })
		]);
		expect(MINUTE).toBe(60);
	});
});
