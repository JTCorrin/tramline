import type { AgentHello, AgentReport } from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deployment, node } from '../db/schema';
import * as changes from '../domain/changes';
import * as deployments from '../domain/deployments';
import * as environments from '../domain/environments';
import * as projects from '../domain/projects';
import * as services from '../domain/services';
import { seedCtx, testSecrets } from '../testing';
import { buildDesiredState, containerName } from './desired';
import { readLogs } from './logs';
import { DEPLOY_TIMEOUT_MS, reconcile, STABLE_AFTER_MS } from './reconciler';
import {
	authenticate,
	ensureLocalNode,
	isOnline,
	nodeStatus,
	recordHello,
	recordReport
} from './registry';

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

function setup(options: { publicDomain?: boolean; healthcheck?: string; replicas?: number } = {}) {
	const ctx = seedCtx();
	ctx.settings = { ...ctx.settings, dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-cp-')) };
	const { node: local, tokenFile } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
	const project = projects.create(ctx, { name: 'Shop' });
	const [env] = environments.list(ctx, project.id);
	const svc = services.create(ctx, {
		projectId: project.id,
		kind: 'image',
		source: { type: 'image', image: 'traefik/whoami' }
	});
	services.stageConfig(ctx, svc.id, env!.id, {
		networking: { port: 80, publicDomain: options.publicDomain ?? false },
		deploy: { healthcheckPath: options.healthcheck ?? null, replicas: options.replicas ?? 1 }
	});
	return { ctx, local, tokenFile, env: env!, svc };
}

const report = (
	deploymentId: string,
	overrides: Partial<AgentReport['containers'][number]> = {},
	replica = 0
): AgentReport['containers'][number] => ({
	name: containerName(deploymentId, replica),
	deploymentId,
	replica,
	state: 'running',
	healthy: null,
	exitCode: null,
	restartCount: 0,
	error: null,
	startedAt: new Date(Date.now() - 10_000).toISOString(),
	...overrides
});

const statusOf = (ctx: ReturnType<typeof setup>['ctx'], id: string) =>
	ctx.db.select().from(deployment).where(eq(deployment.id, id)).get()!;

describe('node registry', () => {
	it('creates the local node once and authenticates its token', () => {
		const { ctx, local, tokenFile } = setup();
		const token = readFileSync(tokenFile, 'utf8').trim();
		expect(token).toMatch(/^tlnode_/);
		expect(authenticate(ctx.db, token)?.id).toBe(local.id);
		expect(authenticate(ctx.db, 'nope')).toBeUndefined();
		expect(authenticate(ctx.db, null)).toBeUndefined();
		expect(ensureLocalNode(ctx.db, ctx.settings.dataDir).node.id).toBe(local.id);
	});

	it('tracks online, offline and Docker errors', () => {
		const { ctx, local } = setup();
		const row = () => ctx.db.select().from(node).where(eq(node.id, local.id)).get()!;
		expect(nodeStatus(row())).toBe('offline');

		recordHello(ctx.db, local.id, hello);
		expect(nodeStatus(row())).toBe('online');
		expect(isOnline(row())).toBe(true);
		expect(isOnline(row(), Date.now() + 60_000)).toBe(false);

		recordHello(ctx.db, local.id, { ...hello, docker: null, dockerError: 'socket missing' });
		expect(row().error).toBe('socket missing');
		expect(nodeStatus(row())).toBe('error');
	});
});

describe('reconciler and desired state', () => {
	it('waits for a node, then schedules and goes live once replicas are stable', () => {
		const { ctx, local, env } = setup({ publicDomain: true });
		const [dep] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id)).toMatchObject({
			status: 'queued',
			message: 'Waiting for a node to come online'
		});

		recordHello(ctx.db, local.id, hello);
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id)).toMatchObject({
			status: 'deploying',
			nodeId: local.id,
			message: 'Pulling image'
		});

		// desired state now holds the container, but no public route until it is live
		const desired = buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id);
		expect(desired.networks).toEqual([`tl-${env.id}`]);
		expect(desired.containers).toHaveLength(1);
		expect(desired.containers[0]).toMatchObject({
			image: 'traefik/whoami',
			port: 80,
			aliases: [
				expect.stringMatching(/\.production\.tramline\.internal$/),
				`${dep!.id}.tramline.internal`
			]
		});
		expect(desired.containers[0]!.env.TRAMLINE_PUBLIC_DOMAIN).toMatch(
			/^whoami-[0-9a-f]{6}\.localhost$/
		);
		expect(desired.ingress).toMatchObject({ httpPort: 8080, tls: false, routes: [] });

		// running for a moment is not enough without a healthcheck
		recordReport(ctx.db, local.id, {
			revision: desired.revision,
			containers: [report(dep!.id, { startedAt: new Date().toISOString() })]
		});
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id).status).toBe('deploying');
		reconcile(ctx.db, ctx.settings, Date.now() + STABLE_AFTER_MS + 100);
		expect(statusOf(ctx, dep!.id)).toMatchObject({ status: 'active', message: null });

		const live = buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id);
		expect(live.ingress.routes).toEqual([
			{
				host: desired.containers[0]!.env.TRAMLINE_PUBLIC_DOMAIN,
				upstreams: [`${dep!.id}.tramline.internal:80`],
				network: `tl-${env.id}`
			}
		]);
		expect(live.revision).not.toBe(desired.revision);
		expect(buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).revision).toBe(
			live.revision
		);
		expect(readLogs(ctx.settings.dataDir, dep!.id).map((l) => l.line)).toEqual([
			'Queued',
			`Scheduled on node local`,
			'Deployment is live'
		]);
	});

	it('swaps deployments only once the replacement is live', () => {
		const { ctx, local, env, svc } = setup();
		recordHello(ctx.db, local.id, hello);
		const [first] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		recordReport(ctx.db, local.id, { revision: null, containers: [report(first!.id)] });
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, first!.id).status).toBe('active');

		const second = deployments.redeploy(ctx, first!.id);
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, second.id).status).toBe('deploying');
		expect(statusOf(ctx, first!.id).status).toBe('active');
		expect(
			buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).containers.map(
				(c) => c.deploymentId
			)
		).toEqual([first!.id, second.id].sort());

		recordReport(ctx.db, local.id, {
			revision: null,
			containers: [report(first!.id), report(second.id)]
		});
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, second.id).status).toBe('active');
		expect(statusOf(ctx, first!.id)).toMatchObject({
			status: 'removed',
			message: `Replaced by ${second.id}`
		});
		expect(
			deployments.list(ctx, { serviceId: svc.id, environmentId: env.id }).map((d) => d.status)
		).toEqual(['active', 'removed']);
	});

	it('requires a passing healthcheck when one is configured', () => {
		const { ctx, local, env } = setup({ healthcheck: '/health' });
		recordHello(ctx.db, local.id, hello);
		const [dep] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		recordReport(ctx.db, local.id, {
			revision: null,
			containers: [report(dep!.id, { healthy: false })]
		});
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id)).toMatchObject({
			status: 'deploying',
			message: 'Waiting for /health to return 200'
		});
		recordReport(ctx.db, local.id, {
			revision: null,
			containers: [report(dep!.id, { healthy: true })]
		});
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id).status).toBe('active');
	});

	it('fails on pull errors, startup crash loops and timeouts', () => {
		const { ctx, local, env } = setup({ replicas: 2 });
		recordHello(ctx.db, local.id, hello);
		const [dep] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		recordReport(ctx.db, local.id, {
			revision: null,
			containers: [report(dep!.id, { state: 'error', error: 'manifest unknown' })]
		});
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id)).toMatchObject({ status: 'failed', message: 'manifest unknown' });
		expect(buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).containers).toEqual([]);

		const crash = deployments.redeploy(ctx, dep!.id);
		reconcile(ctx.db, ctx.settings);
		recordReport(ctx.db, local.id, {
			revision: null,
			containers: [report(crash.id, { state: 'restarting', restartCount: 3, exitCode: 1 })]
		});
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, crash.id)).toMatchObject({
			status: 'failed',
			message: 'Crashed during startup (exit code 1)'
		});

		const slow = deployments.redeploy(ctx, dep!.id);
		reconcile(ctx.db, ctx.settings);
		recordReport(ctx.db, local.id, {
			revision: null,
			containers: [0, 1].map((r) => report(slow.id, { state: 'starting', startedAt: null }, r))
		});
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, slow.id).message).toBe('Starting');
		reconcile(ctx.db, ctx.settings, Date.now() + DEPLOY_TIMEOUT_MS + 1000);
		expect(statusOf(ctx, slow.id).status).toBe('failed');
	});

	it('starts the deploy timeout when the deployment is scheduled, not when it was queued', () => {
		const { ctx, local, env } = setup();
		const [dep] = changes.deploy(ctx, env.id);
		const anHourLater = Date.now() + 60 * 60_000;
		// the node only shows up an hour later
		recordHello(ctx.db, local.id, hello);
		ctx.db
			.update(node)
			.set({ lastSeenAt: new Date(anHourLater) })
			.where(eq(node.id, local.id))
			.run();
		reconcile(ctx.db, ctx.settings, anHourLater);
		expect(statusOf(ctx, dep!.id)).toMatchObject({
			status: 'deploying',
			startedAt: new Date(anHourLater)
		});
		reconcile(ctx.db, ctx.settings, anHourLater + 1_000);
		expect(statusOf(ctx, dep!.id).status).toBe('deploying');
		reconcile(ctx.db, ctx.settings, anHourLater + DEPLOY_TIMEOUT_MS + 1_000);
		expect(statusOf(ctx, dep!.id).status).toBe('failed');
	});

	it('marks live deployments crashed and recovered', () => {
		const { ctx, local, env } = setup();
		recordHello(ctx.db, local.id, hello);
		const [dep] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		recordReport(ctx.db, local.id, { revision: null, containers: [report(dep!.id)] });
		reconcile(ctx.db, ctx.settings);

		recordReport(ctx.db, local.id, {
			revision: null,
			containers: [report(dep!.id, { state: 'exited', exitCode: 2 })]
		});
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id)).toMatchObject({
			status: 'crashed',
			message: 'Crashed (exit code 2)'
		});
		// crashed deployments keep their containers so Docker's restart policy can bring them back
		expect(buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).containers).toHaveLength(
			1
		);

		recordReport(ctx.db, local.id, { revision: null, containers: [report(dep!.id)] });
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id)).toMatchObject({ status: 'active', message: null });
	});

	it('removes deployments on request and refuses to remove twice', () => {
		const { ctx, local, env } = setup();
		recordHello(ctx.db, local.id, hello);
		const [dep] = changes.deploy(ctx, env.id);
		expect(deployments.remove(ctx, dep!.id).status).toBe('removed');
		expect(() => deployments.remove(ctx, dep!.id)).toThrow('not running');
		expect(deployments.get(ctx, dep!.id).message).toBe('Removed');
		expect(() => deployments.get(seedCtx(ctx.db), dep!.id)).toThrow('Deployment not found');
	});

	it('says which node is broken when nothing can run the deployment', () => {
		const { ctx, local, env } = setup();
		recordHello(ctx.db, local.id, {
			...hello,
			docker: null,
			dockerError: 'Docker is unavailable: connect ENOENT'
		});
		const [dep] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id)).toMatchObject({
			status: 'queued',
			message: 'Waiting for a node: local reports "Docker is unavailable: connect ENOENT"'
		});
	});

	it('leaves source builds queued until Phase 3', () => {
		const ctx = seedCtx();
		ctx.settings = { ...ctx.settings, dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-cp-')) };
		const { node: local } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
		recordHello(ctx.db, local.id, hello);
		const project = projects.create(ctx, { name: 'Repo' });
		const [env] = environments.list(ctx, project.id);
		services.create(ctx, {
			projectId: project.id,
			kind: 'repo',
			source: { type: 'repo', repo: 'acme/api', branch: 'main', rootDirectory: '/' }
		});
		const [dep] = changes.deploy(ctx, env!.id);
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id)).toMatchObject({
			status: 'queued',
			message: expect.stringContaining('Phase 3')
		});
	});

	it('requires a port for public domains and keeps the generated domain across deploys', () => {
		const { ctx, env, svc } = setup({ publicDomain: true });
		changes.deploy(ctx, env.id);
		const url = (c = ctx) => c.db.query.serviceInstance.findFirst().sync()!.domain;
		const first = url();
		expect(first).toMatch(/^whoami-[0-9a-f]{6}\.localhost$/);

		services.stageConfig(ctx, svc.id, env.id, { deploy: { replicas: 2 } });
		changes.deploy(ctx, env.id);
		expect(url()).toBe(first);

		services.stageConfig(ctx, svc.id, env.id, { networking: { port: null } });
		expect(() => changes.deploy(ctx, env.id)).toThrow(
			'Set a port on whoami to give it a public domain'
		);
	});
});
