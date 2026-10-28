import type { AgentHello, ServiceConfigPatch } from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deployment, node } from '../db/schema';
import { reconcile } from '../nodes/reconciler';
import { authenticate, ensureLocalNode, join, recordHello, recordReport } from '../nodes/registry';
import { grantInstallAdmin, seedCtx } from '../testing';
import * as changes from './changes';
import type { Ctx } from './context';
import * as environments from './environments';
import * as nodes from './nodes';
import * as projects from './projects';
import * as services from './services';

const hello = (memoryMb = 8192): AgentHello => ({
	protocol: 1,
	agentVersion: 'test',
	hostname: 'box',
	os: 'linux',
	arch: 'arm64',
	cpus: 4,
	memoryMb,
	docker: { version: '27.0.0' }
});

/** An install with its local node online, and a project; the seeded user signed up first. */
function setup() {
	const ctx = grantInstallAdmin(seedCtx());
	ctx.settings = { ...ctx.settings, dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-nodes-')) };
	const { node: local } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
	recordHello(ctx.db, local.id, hello());
	const project = projects.create(ctx, { name: 'Shop' });
	const [env] = environments.list(ctx, project.id);
	return { ctx, local, project, env: env! };
}

/** Enrolls a machine through a join token, as its agent would. */
function enroll(ctx: Ctx, name: string, options: { memoryMb?: number; cordoned?: boolean } = {}) {
	const created = nodes.createJoinToken(
		ctx,
		{ name, cordoned: options.cordoned },
		'http://tramline.test'
	);
	const joined = join(ctx.db, created.token, hello(options.memoryMb));
	return ctx.db.select().from(node).where(eq(node.id, joined.nodeId)).get()!;
}

function addService(
	ctx: Ctx,
	projectId: string,
	envId: string,
	patch: ServiceConfigPatch = {},
	image = 'traefik/whoami'
) {
	const svc = services.create(ctx, { projectId, kind: 'image', source: { type: 'image', image } });
	services.stageConfig(ctx, svc.id, envId, { build: { scan: 'off' }, ...patch });
	return svc;
}

/** Deploys the environment's staged changes and returns where each service landed. */
function deployAll(ctx: Ctx, envId: string) {
	const created = changes.deploy(ctx, envId);
	reconcile(ctx.db, ctx.settings);
	return Object.fromEntries(
		created.map((d) => {
			const row = ctx.db.select().from(deployment).where(eq(deployment.id, d.id)).get()!;
			return [d.serviceId, row];
		})
	);
}

describe('install admins', () => {
	it('API tokens never manage nodes, even an admin’s', () => {
		const { ctx } = setup();
		const viaToken = { ...ctx, token: { id: 'tok_1', name: 'ci', scopes: ['deploy' as const] } };
		expect(() => nodes.createJoinToken(viaToken, { name: 'box' }, 'http://x')).toThrow(
			"Only this install's admins"
		);
	});

	it('signing up first, or later, grants nothing', () => {
		const { ctx } = setup();
		const later = seedCtx(ctx.db);
		expect(() => nodes.createJoinToken(later, { name: 'box' }, 'http://x')).toThrow(
			"Only this install's admins can add nodes"
		);
	});
});

describe('joining', () => {
	it('trades a join token for a node token once', () => {
		const { ctx } = setup();
		// without TRAMLINE_URL the command uses the address the admin is browsing
		ctx.settings = { ...ctx.settings, publicUrl: null };
		const created = nodes.createJoinToken(ctx, { name: 'hetzner-1' }, 'http://tramline.test/');
		expect(created.command).toBe(
			`curl -fsSL http://tramline.test/install.sh | sudo sh -s -- --url http://tramline.test --token ${created.token}`
		);
		expect(created.token).toMatch(/^tljoin_/);

		const joined = join(ctx.db, created.token, hello());
		expect(joined.name).toBe('hetzner-1');
		expect(joined.token).toMatch(/^tlnode_/);
		expect(authenticate(ctx.db, joined.token)?.id).toBe(joined.nodeId);
		// the join token is not a node token, and works only once
		expect(authenticate(ctx.db, created.token)).toBeUndefined();
		expect(() => join(ctx.db, created.token, hello())).toThrow('invalid or has expired');

		const listed = nodes.list(ctx).find((n) => n.name === 'hetzner-1')!;
		expect(listed).toMatchObject({ status: 'online', cpus: 4, memoryMb: 8192, cordoned: false });
	});

	it('refuses expired and unknown tokens, and names already taken', () => {
		const { ctx } = setup();
		const past = new Date(Date.now() - 2 * nodes.JOIN_TOKEN_TTL_MS);
		const old = nodes.createJoinToken(ctx, { name: 'old' }, 'http://x', past);
		expect(() => join(ctx.db, old.token, hello())).toThrow('invalid or has expired');
		expect(() => join(ctx.db, 'tljoin_nope', hello())).toThrow('invalid or has expired');

		expect(() => nodes.createJoinToken(ctx, { name: 'local' }, 'http://x')).toThrow(
			'already a node called local'
		);
		nodes.createJoinToken(ctx, { name: 'pending' }, 'http://x');
		expect(() => nodes.createJoinToken(ctx, { name: 'pending' }, 'http://x')).toThrow(
			'already a node called pending'
		);
		// an expired invitation frees its name
		nodes.createJoinToken(ctx, { name: 'old' }, 'http://x');
	});

	it('can start cordoned', () => {
		const { ctx } = setup();
		expect(enroll(ctx, 'quiet', { cordoned: true }).cordoned).toBe(true);
	});
});

describe('scheduling', () => {
	it('places new work on the least loaded node', () => {
		const { ctx, project, env, local } = setup();
		const a = addService(ctx, project.id, env.id, { deploy: { memoryMb: 1024 } });
		// alone, the local node takes it
		expect(deployAll(ctx, env.id)[a.id]!.nodeId).toBe(local.id);

		// another environment goes where there is the most room
		const big = enroll(ctx, 'big', { memoryMb: 16_384 });
		const staging = environments.create(ctx, { projectId: project.id, name: 'staging' });
		services.stageConfig(ctx, a.id, staging.id, {
			build: { scan: 'off' },
			deploy: { memoryMb: 1024 }
		});
		expect(deployAll(ctx, staging.id)[a.id]!.nodeId).toBe(big.id);
	});

	it('keeps an environment together, so its services find each other', () => {
		const { ctx, project, env } = setup();
		enroll(ctx, 'second');
		const a = addService(ctx, project.id, env.id);
		const first = deployAll(ctx, env.id)[a.id]!.nodeId;
		const b = addService(ctx, project.id, env.id);
		const c = addService(ctx, project.id, env.id);
		const placed = deployAll(ctx, env.id);
		expect(placed[b.id]!.nodeId).toBe(first);
		expect(placed[c.id]!.nodeId).toBe(first);
	});

	it('skips cordoned nodes, unless the service is pinned there', () => {
		const { ctx, project, env, local } = setup();
		const quiet = enroll(ctx, 'quiet', { cordoned: true });
		const a = addService(ctx, project.id, env.id);
		const b = addService(ctx, project.id, env.id, { deploy: { node: quiet.id } });
		const placed = deployAll(ctx, env.id);
		expect(placed[a.id]!.nodeId).toBe(local.id);
		expect(placed[b.id]!.nodeId).toBe(quiet.id);

		nodes.update(ctx, local.id, { cordoned: true });
		const c = addService(ctx, project.id, env.id);
		expect(deployAll(ctx, env.id)[c.id]).toMatchObject({
			status: 'queued',
			message: 'Waiting for a node: every online node is cordoned'
		});
	});

	it('waits for a pinned node, and says when it is gone', () => {
		const { ctx, project, env } = setup();
		const away = enroll(ctx, 'away');
		ctx.db
			.update(node)
			.set({ lastSeenAt: new Date(0) })
			.where(eq(node.id, away.id))
			.run();
		const a = addService(ctx, project.id, env.id, { deploy: { node: away.id } });
		const b = addService(ctx, project.id, env.id, { deploy: { node: 'node_gone' } });
		const placed = deployAll(ctx, env.id);
		expect(placed[a.id]!.message).toBe('Waiting for away, which this service is pinned to');
		expect(placed[b.id]!.message).toBe(
			'Pinned to a node that no longer exists. Choose another in Settings.'
		);
	});

	it('only places a memory limit where it fits', () => {
		const { ctx, project, env, local } = setup();
		const small = enroll(ctx, 'small', { memoryMb: 1024 });
		const a = addService(ctx, project.id, env.id, { deploy: { memoryMb: 2048, node: null } });
		expect(deployAll(ctx, env.id)[a.id]!.nodeId).toBe(local.id);

		nodes.update(ctx, local.id, { cordoned: true });
		const b = addService(ctx, project.id, env.id, { deploy: { memoryMb: 4096 } });
		expect(deployAll(ctx, env.id)[b.id]!.message).toBe(
			'Waiting for a node with 4096 MB of memory free'
		);
		expect(nodes.list(ctx).find((n) => n.id === small.id)!.allocatedMemoryMb).toBe(0);
		expect(nodes.list(ctx).find((n) => n.id === local.id)!.allocatedMemoryMb).toBe(2048);
	});

	it('runs a service with a volume where its data is, even when cordoned', () => {
		const { ctx, project, env, local } = setup();
		const a = addService(ctx, project.id, env.id, { volume: { mountPath: '/data' } });
		expect(deployAll(ctx, env.id)[a.id]!.nodeId).toBe(local.id);

		enroll(ctx, 'second');
		nodes.update(ctx, local.id, { cordoned: true });
		services.stageConfig(ctx, a.id, env.id, { deploy: { replicas: 1, startCommand: 'again' } });
		expect(deployAll(ctx, env.id)[a.id]!.nodeId).toBe(local.id);
	});

	it('builds again on a node that does not have the built image', () => {
		const { ctx, project, env, local } = setup();
		const svc = services.create(ctx, {
			projectId: project.id,
			kind: 'repo',
			source: {
				type: 'repo',
				repo: 'https://github.com/acme/app',
				branch: 'main',
				rootDirectory: '/'
			}
		});
		const [built] = changes.deploy(ctx, env.id);
		ctx.db
			.update(deployment)
			.set({ status: 'active', nodeId: local.id, image: 'tramline/app:abc', commit: 'abc' })
			.where(eq(deployment.id, built!.id))
			.run();

		const other = enroll(ctx, 'other');
		const result = nodes.drain(ctx, local.id);
		expect(result).toEqual({ moved: 1, kept: [] });
		reconcile(ctx.db, ctx.settings);
		const moved = ctx.db
			.select()
			.from(deployment)
			.where(eq(deployment.serviceId, svc.id))
			.all()
			.find((d) => d.id !== built!.id)!;
		expect(moved).toMatchObject({
			nodeId: other.id,
			status: 'building',
			image: null,
			commit: 'abc'
		});
	});
});

describe('draining and removing', () => {
	it('moves stateless deployments and keeps those with data or a pin', () => {
		const { ctx, project, env, local } = setup();
		const web = addService(ctx, project.id, env.id);
		const db = addService(ctx, project.id, env.id, { volume: { mountPath: '/data' } });
		const pinned = addService(ctx, project.id, env.id, { deploy: { node: local.id } });
		const placed = deployAll(ctx, env.id);
		for (const dep of Object.values(placed)) {
			ctx.db.update(deployment).set({ status: 'active' }).where(eq(deployment.id, dep.id)).run();
		}
		const other = enroll(ctx, 'other');

		const result = nodes.drain(ctx, local.id);
		expect(result.moved).toBe(1);
		expect(result.kept.map((k) => k.service).sort()).toEqual([db.name, pinned.name].sort());
		expect(nodes.list(ctx).find((n) => n.id === local.id)).toMatchObject({
			cordoned: true,
			draining: true
		});

		reconcile(ctx.db, ctx.settings);
		const copies = ctx.db.select().from(deployment).where(eq(deployment.serviceId, web.id)).all();
		expect(copies).toHaveLength(2);
		expect(copies.find((d) => d.id !== placed[web.id]!.id)!.nodeId).toBe(other.id);

		// uncordoning ends the drain
		expect(nodes.update(ctx, local.id, { cordoned: false })).toMatchObject({
			cordoned: false,
			draining: false
		});
	});

	it('removes an empty node and revokes its token, but not one still in use', async () => {
		const { ctx, project, env, local } = setup();
		const created = nodes.createJoinToken(ctx, { name: 'spare' }, 'http://x');
		const joined = join(ctx.db, created.token, hello());

		await expect(nodes.remove(ctx, local.id)).rejects.toThrow('Cordon it instead');
		const a = addService(ctx, project.id, env.id, { deploy: { node: joined.nodeId } });
		deployAll(ctx, env.id);
		await expect(nodes.remove(ctx, joined.nodeId)).rejects.toThrow(
			'still runs 1 deployment. Drain it'
		);

		ctx.db
			.update(deployment)
			.set({ status: 'removed' })
			.where(eq(deployment.serviceId, a.id))
			.run();
		await nodes.remove(ctx, joined.nodeId);
		expect(authenticate(ctx.db, joined.token)).toBeUndefined();
		expect(nodes.list(ctx).map((n) => n.name)).toEqual(['local']);
	});

	it('will not remove a node holding a service’s data', async () => {
		const { ctx, project, env } = setup();
		const box = enroll(ctx, 'box');
		const a = addService(ctx, project.id, env.id, {
			volume: { mountPath: '/data' },
			deploy: { node: box.id }
		});
		deployAll(ctx, env.id);
		ctx.db
			.update(deployment)
			.set({ status: 'removed' })
			.where(eq(deployment.serviceId, a.id))
			.run();
		await expect(nodes.remove(ctx, box.id)).rejects.toThrow(`holds the data of ${a.name}`);
	});
});

describe('reports', () => {
	it('count only for deployments placed on the reporting node', () => {
		const { ctx, project, env, local } = setup();
		const other = enroll(ctx, 'other');
		const svc = services.create(ctx, {
			projectId: project.id,
			kind: 'repo',
			source: {
				type: 'repo',
				repo: 'https://github.com/acme/app',
				branch: 'main',
				rootDirectory: '/'
			}
		});
		const [dep] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		const row = () => ctx.db.select().from(deployment).where(eq(deployment.id, dep!.id)).get()!;
		expect(row()).toMatchObject({ status: 'building' });
		const honest = row().nodeId!;
		const thief = honest === local.id ? other.id : local.id;

		// another node claims the build succeeded with an image of its choosing
		recordReport(ctx.db, thief, {
			revision: null,
			containers: [],
			builds: [
				{
					deploymentId: dep!.id,
					state: 'succeeded',
					image: 'attacker/image',
					commit: 'c'.repeat(40),
					error: null
				}
			]
		});
		reconcile(ctx.db, ctx.settings);
		expect(row()).toMatchObject({ status: 'building', image: null });

		recordReport(ctx.db, honest, {
			revision: null,
			containers: [],
			builds: [
				{
					deploymentId: dep!.id,
					state: 'succeeded',
					image: 'sha256:real',
					commit: 'c'.repeat(40),
					error: null
				}
			]
		});
		reconcile(ctx.db, ctx.settings);
		expect(row()).toMatchObject({ status: 'deploying', image: 'sha256:real' });
		expect(svc.id).toBe(row().serviceId);
	});
});
