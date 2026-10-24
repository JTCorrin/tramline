import type { AgentHello, AgentReport, ScanMode, ScanResult } from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cronRun, deployment, node } from '../db/schema';
import * as changes from '../domain/changes';
import * as deployments from '../domain/deployments';
import * as environments from '../domain/environments';
import * as projects from '../domain/projects';
import * as services from '../domain/services';
import * as variables from '../domain/variables';
import { seedCtx, testSecrets } from '../testing';
import { buildDesiredState, containerName } from './desired';
import { RUN_TIMEOUT_MS, runContainerName } from './cron';
import { readLogs } from './logs';
import { volumeFor, volumeName } from './volumes';
import { BUILD_TIMEOUT_MS, DEPLOY_TIMEOUT_MS, reconcile, STABLE_AFTER_MS } from './reconciler';
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

function setup(
	options: {
		publicDomain?: boolean;
		healthcheck?: string;
		replicas?: number;
		scan?: ScanMode;
		mountPath?: string;
		cron?: string;
	} = {}
) {
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
		deploy: {
			healthcheckPath: options.healthcheck ?? null,
			replicas: options.replicas ?? 1,
			cronSchedule: options.cron ?? null
		},
		// most tests are about deploying; scanning has its own
		build: { scan: options.scan ?? 'off' },
		volume: { mountPath: options.mountPath ?? null }
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

	it('builds source deployments, then runs the built image', () => {
		const ctx = seedCtx();
		ctx.settings = { ...ctx.settings, dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-cp-')) };
		const { node: local } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
		recordHello(ctx.db, local.id, hello);
		const project = projects.create(ctx, { name: 'Repo' });
		const [env] = environments.list(ctx, project.id);
		const svc = services.create(ctx, {
			projectId: project.id,
			kind: 'repo',
			source: {
				type: 'repo',
				repo: 'https://github.com/acme/api',
				branch: 'main',
				rootDirectory: '/'
			}
		});
		services.stageConfig(ctx, svc.id, env!.id, { networking: { port: 8080 } });
		variables.stage(ctx, {
			environmentId: env!.id,
			serviceId: svc.id,
			set: { NPM_TOKEN: 'npm_secret_123' },
			unset: []
		});
		const [dep] = changes.deploy(ctx, env!.id);
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id)).toMatchObject({
			status: 'building',
			message: 'Waiting for the builder',
			nodeId: local.id
		});

		const desired = buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id);
		expect(desired.containers).toEqual([]);
		expect(desired.builds).toEqual([
			expect.objectContaining({
				deploymentId: dep!.id,
				repo: 'https://github.com/acme/api',
				ref: 'main',
				commit: null,
				token: null,
				builder: 'railpack',
				image: `tramline/${svc.id}:${dep!.id}`,
				secrets: expect.objectContaining({ NPM_TOKEN: 'npm_secret_123', PORT: '8080' })
			})
		]);

		const reportBuild = (b: Partial<AgentReport['builds'][number]>) =>
			recordReport(ctx.db, local.id, {
				revision: null,
				containers: [],
				builds: [
					{ deploymentId: dep!.id, state: 'running', image: null, commit: null, error: null, ...b }
				]
			});
		reportBuild({ state: 'running' });
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id)).toMatchObject({ status: 'building', message: 'Building' });

		reportBuild({ state: 'succeeded', image: 'sha256:abc', commit: 'deadbeefcafe' });
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id)).toMatchObject({
			status: 'deploying',
			image: 'sha256:abc',
			commit: 'deadbeefcafe'
		});
		const next = buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id);
		expect(next.builds).toEqual([]);
		expect(next.containers[0]).toMatchObject({ image: 'sha256:abc', port: 8080 });
		expect(deployments.get(ctx, dep!.id).commit).toBe('deadbeefcafe');
		expect(readLogs(ctx.settings.dataDir, dep!.id).map((l) => l.line)).toContain(
			'Build succeeded (deadbee)'
		);

		// a redeploy reuses the image instead of rebuilding
		const again = deployments.redeploy(ctx, dep!.id);
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, again.id)).toMatchObject({
			status: 'deploying',
			image: 'sha256:abc',
			commit: 'deadbeefcafe'
		});
	});

	it('fails builds that fail or take too long', () => {
		const ctx = seedCtx();
		ctx.settings = { ...ctx.settings, dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-cp-')) };
		const { node: local } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
		recordHello(ctx.db, local.id, hello);
		const project = projects.create(ctx, { name: 'Broken' });
		const [env] = environments.list(ctx, project.id);
		services.create(ctx, {
			projectId: project.id,
			kind: 'repo',
			source: {
				type: 'repo',
				repo: 'https://github.com/acme/api',
				branch: 'main',
				rootDirectory: '/'
			}
		});
		const [dep] = changes.deploy(ctx, env!.id);
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id).message).toBe('Waiting for the builder');
		recordReport(ctx.db, local.id, {
			revision: null,
			containers: [],
			builds: [
				{
					deploymentId: dep!.id,
					state: 'failed',
					image: null,
					commit: 'abc',
					error: 'No start command was found'
				}
			]
		});
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id)).toMatchObject({
			status: 'failed',
			message: 'No start command was found'
		});

		services.stageConfig(ctx, dep!.serviceId, env!.id, { deploy: { replicas: 2 } });
		const [slow] = changes.deploy(ctx, env!.id);
		reconcile(ctx.db, ctx.settings);
		reconcile(ctx.db, ctx.settings, Date.now() + BUILD_TIMEOUT_MS + 1_000);
		expect(statusOf(ctx, slow!.id)).toMatchObject({
			status: 'failed',
			message: 'Timed out building'
		});
	});

	it('pins the digest an image deployment pulled, and rolls back to exactly that image', () => {
		const { ctx, local, env } = setup();
		recordHello(ctx.db, local.id, hello);
		const [dep] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		const digest = 'traefik/whoami@sha256:1111';
		recordReport(ctx.db, local.id, {
			revision: null,
			containers: [report(dep!.id, { imageDigest: digest })]
		});
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id)).toMatchObject({
			status: 'active',
			resolvedImage: digest,
			image: null
		});
		// the running container keeps its spec (no restart because a digest appeared)
		expect(
			buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).containers[0]!.image
		).toBe('traefik/whoami');

		const rollback = deployments.redeploy(ctx, dep!.id);
		reconcile(ctx.db, ctx.settings);
		const images = buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).containers.map(
			(c) => [c.deploymentId, c.image]
		);
		expect(images).toContainEqual([rollback.id, digest]);
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

describe('image scanning', () => {
	const DIGEST = 'traefik/whoami@sha256:2222';
	const scan = (outcome: ScanResult['outcome']): ScanResult => ({
		scanner: 'Trivy 0.75.0',
		outcome,
		counts: { critical: 1, high: 0, medium: 0, low: 0, unknown: 0 },
		fixableCritical: 1,
		findings: [],
		error: null,
		scannedAt: new Date().toISOString()
	});

	it('scans a registry image first, then runs exactly the digest that was scanned', () => {
		const { ctx, local, env } = setup({ scan: 'warn' });
		recordHello(ctx.db, local.id, hello);
		const [dep] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id)).toMatchObject({ status: 'building', message: 'Scanning image' });
		const desired = buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id);
		expect(desired.scans).toEqual([
			{ deploymentId: dep!.id, image: 'traefik/whoami', scan: 'warn' }
		]);
		expect(desired.builds).toEqual([]);
		expect(desired.containers).toEqual([]);

		recordReport(ctx.db, local.id, {
			revision: null,
			containers: [],
			builds: [{ deploymentId: dep!.id, state: 'running', image: null, commit: null, error: null }]
		});
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id).message).toBe('Scanning image');

		recordReport(ctx.db, local.id, {
			revision: null,
			containers: [],
			builds: [
				{
					deploymentId: dep!.id,
					state: 'succeeded',
					image: DIGEST,
					commit: null,
					error: null,
					scan: scan('warned')
				}
			]
		});
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id)).toMatchObject({
			status: 'deploying',
			image: DIGEST,
			resolvedImage: DIGEST,
			scan: { outcome: 'warned', fixableCritical: 1 }
		});
		expect(
			buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).containers[0]!.image
		).toBe(DIGEST);
		expect(deployments.get(ctx, dep!.id).scan?.outcome).toBe('warned');
		expect(readLogs(ctx.settings.dataDir, dep!.id).map((l) => l.line)).toContain(
			`Scanned ${DIGEST}`
		);

		// a redeploy reuses the scanned image and its scan
		const again = deployments.redeploy(ctx, dep!.id);
		expect(again.scan?.outcome).toBe('warned');
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, again.id).status).toBe('deploying');
	});

	it('fails a deployment whose image is blocked, keeping the scan', () => {
		const { ctx, local, env } = setup({ scan: 'block' });
		recordHello(ctx.db, local.id, hello);
		const [dep] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		expect(buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).scans[0]!.scan).toBe(
			'block'
		);
		recordReport(ctx.db, local.id, {
			revision: null,
			containers: [],
			builds: [
				{
					deploymentId: dep!.id,
					state: 'failed',
					image: null,
					commit: null,
					error: 'Blocked: 1 critical vulnerability with a fix available',
					scan: scan('blocked')
				}
			]
		});
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id)).toMatchObject({
			status: 'failed',
			message: 'Blocked: 1 critical vulnerability with a fix available',
			scan: { outcome: 'blocked' }
		});
		expect(readLogs(ctx.settings.dataDir, dep!.id).map((l) => l.line)).toContain(
			'Scan failed: Blocked: 1 critical vulnerability with a fix available'
		);
		// redeploying an image that never ran scans it again
		expect(deployments.redeploy(ctx, dep!.id).scan).toBeNull();
	});

	it('times out a scan that never finishes', () => {
		const { ctx, local, env } = setup({ scan: 'warn' });
		recordHello(ctx.db, local.id, hello);
		const [dep] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		recordHello(ctx.db, local.id, hello);
		reconcile(ctx.db, ctx.settings, Date.now() + BUILD_TIMEOUT_MS + 1000);
		expect(statusOf(ctx, dep!.id)).toMatchObject({
			status: 'failed',
			message: 'Timed out scanning'
		});
	});

	it('skips scanning when it is off', () => {
		const { ctx, local, env } = setup({ scan: 'off' });
		recordHello(ctx.db, local.id, hello);
		const [dep] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, dep!.id).status).toBe('deploying');
		expect(buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).scans).toEqual([]);
	});
});

describe('volumes', () => {
	const live = (ctx: ReturnType<typeof setup>['ctx'], localId: string, ids: string[]) =>
		recordReport(ctx.db, localId, { revision: null, containers: ids.map((id) => report(id)) });

	it('creates a volume on first deploy, pinned to the node, and mounts it', () => {
		const { ctx, local, env, svc } = setup({ mountPath: '/data' });
		recordHello(ctx.db, local.id, hello);
		const [dep] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);

		const vol = volumeFor(ctx.db, svc.id, env.id)!;
		expect(vol.nodeId).toBe(local.id);
		const [c] = buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).containers;
		expect(c!.deploymentId).toBe(dep!.id);
		expect(c!.volumes).toEqual([{ name: volumeName(vol.id), target: '/data' }]);
		expect(c!.env.TRAMLINE_VOLUME_MOUNT_PATH).toBe('/data');
	});

	it('stops the old deployment before the new one starts, then keeps the same volume', () => {
		const { ctx, local, env } = setup({ mountPath: '/data' });
		recordHello(ctx.db, local.id, hello);
		const [first] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		live(ctx, local.id, [first!.id]);
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, first!.id).status).toBe('active');

		const second = deployments.redeploy(ctx, first!.id);
		reconcile(ctx.db, ctx.settings);
		// neither runs while the old container is still on the node
		expect(buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).containers).toEqual([]);
		expect(statusOf(ctx, second.id).message).toBe('Waiting for the previous deployment to stop');
		expect(statusOf(ctx, first!.id).message).toBe(`Stopping for ${second.id}`);

		// once the agent reports it gone, the new one starts on the same volume
		live(ctx, local.id, []);
		reconcile(ctx.db, ctx.settings);
		const desired = buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id);
		expect(desired.containers.map((c) => c.deploymentId)).toEqual([second.id]);
		expect(statusOf(ctx, second.id).message).toBe('Pulling image');

		live(ctx, local.id, [second.id]);
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, second.id).status).toBe('active');
		expect(statusOf(ctx, first!.id).status).toBe('removed');
	});

	it('gives up when the previous deployment never stops', () => {
		const { ctx, local, env } = setup({ mountPath: '/data' });
		recordHello(ctx.db, local.id, hello);
		const [first] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		live(ctx, local.id, [first!.id]);
		reconcile(ctx.db, ctx.settings);
		const second = deployments.redeploy(ctx, first!.id);
		reconcile(ctx.db, ctx.settings);
		live(ctx, local.id, [first!.id]);
		reconcile(ctx.db, ctx.settings, Date.now() + DEPLOY_TIMEOUT_MS + 1000);
		expect(statusOf(ctx, second.id)).toMatchObject({
			status: 'failed',
			message: 'Timed out waiting for the previous deployment to stop'
		});
		// the old deployment runs again
		reconcile(ctx.db, ctx.settings, Date.now() + DEPLOY_TIMEOUT_MS + 2000);
		expect(
			buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).containers.map(
				(c) => c.deploymentId
			)
		).toEqual([first!.id]);
	});

	it('runs a service with a volume as a single replica', () => {
		const { ctx, env } = setup({ mountPath: '/data', replicas: 2 });
		expect(() => changes.deploy(ctx, env.id)).toThrow('has a volume, so it runs a single replica');
	});

	it('waits for the node that holds the volume', () => {
		const { ctx, local, env } = setup({ mountPath: '/data' });
		recordHello(ctx.db, local.id, hello);
		const [first] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		const second = deployments.redeploy(ctx, first!.id);
		ctx.db
			.update(node)
			.set({ lastSeenAt: new Date(0) })
			.where(eq(node.id, local.id))
			.run();
		reconcile(ctx.db, ctx.settings);
		expect(statusOf(ctx, second.id)).toMatchObject({
			status: 'queued',
			message: "Waiting for local, which holds this service's volume"
		});
	});

	it('removes the volumes of deleted services once the node reports them gone', () => {
		const { ctx, local, env, svc } = setup({ mountPath: '/data' });
		recordHello(ctx.db, local.id, hello);
		changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		const name = volumeName(volumeFor(ctx.db, svc.id, env.id)!.id);
		expect(buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).deletedVolumes).toEqual(
			[]
		);

		services.remove(ctx, svc.id);
		expect(buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).deletedVolumes).toEqual([
			name
		]);
		// still there: keep asking
		recordReport(ctx.db, local.id, { revision: null, containers: [], volumes: [name] });
		expect(buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).deletedVolumes).toEqual([
			name
		]);
		// a report that couldn't list volumes changes nothing
		recordReport(ctx.db, local.id, { revision: null, containers: [] });
		expect(buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).deletedVolumes).toEqual([
			name
		]);
		recordReport(ctx.db, local.id, { revision: null, containers: [], volumes: [] });
		expect(buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).deletedVolumes).toEqual(
			[]
		);
	});
});

describe('cron services', () => {
	const T0 = Date.UTC(2026, 9, 24, 9, 1);
	const minute = 60_000;
	const exited = (
		ctx: ReturnType<typeof setup>['ctx'],
		nodeId: string,
		run: string,
		exitCode: number
	) =>
		recordReport(ctx.db, nodeId, {
			revision: null,
			containers: [
				{
					...report('', { state: 'exited', exitCode }),
					name: runContainerName(run),
					deploymentId: statusOf(
						ctx,
						ctx.db.select().from(cronRun).where(eq(cronRun.id, run)).get()!.deploymentId
					).id
				}
			]
		});

	function deployed(schedule = '*/5 * * * *') {
		const s = setup({ cron: schedule });
		recordHello(s.ctx.db, s.local.id, hello);
		const [dep] = changes.deploy(s.ctx, s.env.id);
		reconcile(s.ctx.db, s.ctx.settings, T0);
		reconcile(s.ctx.db, s.ctx.settings, T0);
		const runs = () =>
			s.ctx.db
				.select()
				.from(cronRun)
				.where(eq(cronRun.deploymentId, dep!.id))
				.orderBy(cronRun.scheduledFor)
				.all();
		const desired = () => buildDesiredState(s.ctx.db, testSecrets, s.ctx.settings, s.local.id);
		return { ...s, dep: dep!, runs, desired };
	}

	it('goes live with no container, and runs on its schedule', () => {
		const { ctx, local, dep, runs, desired } = deployed();
		ctx.db
			.update(deployment)
			.set({ startedAt: new Date(T0) })
			.where(eq(deployment.id, dep.id))
			.run();
		expect(statusOf(ctx, dep.id).status).toBe('active');
		expect(desired().containers).toEqual([]);
		expect(deployments.get(ctx, dep.id).nextRunAt).not.toBeNull();

		// 09:05 comes round
		reconcile(ctx.db, ctx.settings, T0 + 4 * minute);
		const [run] = runs();
		expect(run).toMatchObject({ status: 'running', trigger: 'schedule' });
		expect(run!.scheduledFor).toEqual(new Date(Date.UTC(2026, 9, 24, 9, 5)));
		expect(desired().containers).toEqual([
			expect.objectContaining({
				name: runContainerName(run!.id),
				deploymentId: dep.id,
				restartPolicy: 'never',
				port: null
			})
		]);

		// the next slot finds it still going: skipped, not doubled up
		reconcile(ctx.db, ctx.settings, T0 + 9 * minute);
		expect(runs().map((r) => r.status)).toEqual(['running', 'skipped']);

		exited(ctx, local.id, run!.id, 0);
		reconcile(ctx.db, ctx.settings, T0 + 10 * minute);
		expect(runs()[0]).toMatchObject({ status: 'succeeded', exitCode: 0 });
		expect(desired().containers).toEqual([]);
		// still live, with no container
		expect(statusOf(ctx, dep.id).status).toBe('active');
		expect(readLogs(ctx.settings.dataDir, dep.id).map((l) => l.line)).toContain(
			`Run ${run!.id} finished`
		);
		expect(deployments.runs(ctx, dep.id)[0]).toMatchObject({ status: 'skipped' });
	});

	it('records failures, collapses missed slots after downtime, and times runs out', () => {
		const { ctx, local, dep, runs } = deployed('0 * * * *');
		ctx.db
			.update(deployment)
			.set({ startedAt: new Date(T0) })
			.where(eq(deployment.id, dep.id))
			.run();
		// down for three hours: one run, for the latest slot
		reconcile(ctx.db, ctx.settings, T0 + 3 * 60 * minute);
		expect(runs()).toHaveLength(1);
		expect(runs()[0]!.scheduledFor).toEqual(new Date(Date.UTC(2026, 9, 24, 12, 0)));
		exited(ctx, local.id, runs()[0]!.id, 2);
		reconcile(ctx.db, ctx.settings, T0 + 3 * 60 * minute + minute);
		expect(runs()[0]).toMatchObject({ status: 'failed', exitCode: 2 });

		const late = Date.now() + RUN_TIMEOUT_MS + 60 * minute;
		reconcile(ctx.db, ctx.settings, late);
		const stuck = runs().at(-1)!;
		expect(stuck.status).toBe('running');
		reconcile(ctx.db, ctx.settings, late + RUN_TIMEOUT_MS + minute);
		expect(ctx.db.select().from(cronRun).where(eq(cronRun.id, stuck.id)).get()).toMatchObject({
			status: 'failed',
			error: 'Timed out'
		});
	});

	it('runs on demand, one at a time, for live cron services only', () => {
		const { ctx, dep } = deployed();
		const run = deployments.runNow(ctx, dep.id);
		expect(run).toMatchObject({ trigger: 'manual', status: 'running' });
		expect(() => deployments.runNow(ctx, dep.id)).toThrow('A run is already going');

		const plain = setup();
		recordHello(plain.ctx.db, plain.local.id, hello);
		const [other] = changes.deploy(plain.ctx, plain.env.id);
		expect(() => deployments.runNow(plain.ctx, other!.id)).toThrow(
			'Only a live cron service can be run'
		);
	});

	it('refuses an invalid schedule at deploy', () => {
		const { ctx, env } = setup({ cron: '61 * * * *' });
		expect(() => changes.deploy(ctx, env.id)).toThrow(
			"whoami's cron schedule: The minute field must be between 0 and 59"
		);
	});
});
