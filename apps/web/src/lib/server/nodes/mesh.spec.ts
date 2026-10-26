import type { AgentHello } from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deployment, node, serviceInstance } from '../db/schema';
import * as changes from '../domain/changes';
import type { Ctx } from '../domain/context';
import * as environments from '../domain/environments';
import * as nodes from '../domain/nodes';
import * as projects from '../domain/projects';
import * as services from '../domain/services';
import { seedCtx, testSecrets } from '../testing';
import { buildDesiredState } from './desired';
import {
	linkName,
	meshAlias,
	meshExports,
	meshMembers,
	meshNetworkName,
	meshPorts,
	planMesh,
	routes
} from './mesh';
import { networkName } from './names';
import { reconcile } from './reconciler';
import { ensureLocalNode, join, recordHello } from './registry';

const KEY = (n: number) => `${String(n).padStart(43, 'A')}=`;

const hello = (mesh: AgentHello['mesh'] = null): AgentHello => ({
	protocol: 1,
	agentVersion: 'test',
	hostname: 'box',
	os: 'linux',
	arch: 'arm64',
	cpus: 4,
	memoryMb: 8192,
	docker: { version: '27.0.0' },
	mesh
});

const member = (id: string, endpoint: string | null, n: number) => ({
	id,
	name: id,
	address: `10.231.0.${n}`,
	publicKey: KEY(n),
	endpoint
});

describe('mesh ports', () => {
	it('gives each service the same port everywhere, and adding one moves no other', () => {
		const a = { serviceId: 'svc_a', environmentId: 'env_1' };
		const b = { serviceId: 'svc_b', environmentId: 'env_1' };
		const before = meshPorts([a]);
		const after = meshPorts([b, a, a]);
		expect(after.get('env_1:svc_a')).toBe(before.get('env_1:svc_a'));
		expect(after.size).toBe(2);
		for (const port of after.values()) {
			expect(port).toBeGreaterThanOrEqual(20_000);
			expect(port).toBeLessThan(60_000);
		}
	});

	it('resolves collisions without reusing a port', () => {
		const many = Array.from({ length: 2000 }, (_, i) => ({
			serviceId: `svc_${i}`,
			environmentId: 'env'
		}));
		expect(new Set(meshPorts(many).values()).size).toBe(2000);
	});
});

describe('routes between nodes', () => {
	const pub = member('pub', '203.0.113.1:51820', 1);
	const nat1 = member('nat1', null, 2);
	const nat2 = member('nat2', null, 3);

	it('connects directly whenever either side is reachable', () => {
		const r = routes([pub, nat1], nat1);
		expect(r.direct).toEqual(new Map([['pub', ['10.231.0.1/32']]]));
		expect(r.relays).toBe(false);
	});

	it('relays between two nodes behind NAT through a reachable one', () => {
		const r = routes([pub, nat1, nat2], nat1);
		expect(r.direct).toEqual(new Map([['pub', ['10.231.0.1/32', '10.231.0.3/32']]]));
		expect(r.relayed).toEqual([{ node: nat2, via: pub }]);
		expect(routes([pub, nat1, nat2], pub).relays).toBe(true);
	});

	it('reports pairs that nothing can connect', () => {
		const r = routes([nat1, nat2], nat1);
		expect(r.direct.size).toBe(0);
		expect(r.unreachable).toEqual([nat2]);
	});
});

describe('planMesh', () => {
	const a = member('node_a', '198.51.100.1:51820', 1);
	const b = member('node_b', null, 2);
	const db = {
		serviceId: 'svc_db',
		environmentId: 'env_1',
		nodeId: 'node_b',
		port: 5432,
		alias: 'postgres.production.tramline.internal',
		target: 'dep_db.tramline.internal',
		hosts: [],
		tcp: null
	};
	const web = {
		serviceId: 'svc_web',
		environmentId: 'env_2',
		nodeId: 'node_b',
		port: 3000,
		alias: 'web.production.tramline.internal',
		target: 'dep_web.tramline.internal',
		hosts: [{ host: 'web-1.example.com', custom: false }],
		tcp: null
	};
	const ports = meshPorts([db, web]);

	it('is off on its own', () => {
		expect(planMesh([a], [db], { id: 'node_a', edge: false, networks: [] })).toBeNull();
	});

	it('links a consumer to a service on another node, in its environment only', () => {
		const plan = planMesh([a, b], [db, web], {
			id: 'node_a',
			edge: false,
			networks: [networkName('env_1')]
		})!;
		expect(plan.peers).toEqual([
			{
				nodeId: 'node_b',
				publicKey: KEY(2),
				endpoint: null,
				allowedIps: ['10.231.0.2/32'],
				// node_a is reachable, so node_b keeps the tunnel open
				keepalive: false
			}
		]);
		const port = ports.get('env_1:svc_db')!;
		expect(plan.forwards).toEqual([{ to: 'remote', port, address: '10.231.0.2' }]);
		expect(plan.links).toEqual([
			{
				name: linkName('env_1', 'svc_db'),
				network: networkName('env_1'),
				alias: 'postgres.production.tramline.internal',
				port: 5432,
				meshPort: port
			}
		]);
	});

	it('delivers to its own services, and an edge node forwards to public ones', () => {
		const host = planMesh([a, b], [db, web], { id: 'node_b', edge: false, networks: [] })!;
		expect(host.forwards).toEqual(
			[
				{
					to: 'local',
					port: ports.get('env_1:svc_db')!,
					target: 'dep_db.tramline.internal:5432',
					network: networkName('env_1')
				},
				{
					to: 'local',
					port: ports.get('env_2:svc_web')!,
					target: 'dep_web.tramline.internal:3000',
					network: networkName('env_2')
				}
			].sort((x, y) => x.port - y.port)
		);
		expect(host.peers[0]!.keepalive).toBe(true);

		const edge = planMesh([a, b], [db, web], { id: 'node_a', edge: true, networks: [] })!;
		expect(edge.forwards).toEqual([
			{ to: 'remote', port: ports.get('env_2:svc_web')!, address: '10.231.0.2' }
		]);
		expect(edge.links).toEqual([]);
	});

	it('skips services on nodes it cannot reach', () => {
		const c = member('node_c', null, 3);
		const plan = planMesh([b, c], [db], {
			id: 'node_c',
			edge: false,
			networks: [networkName('env_1')]
		})!;
		expect(plan.forwards).toEqual([]);
		expect(plan.links).toEqual([]);
	});
});

/** Two online nodes with mesh keys; the second is enrolled with a join token. */
function cluster() {
	const ctx = seedCtx();
	ctx.settings = { ...ctx.settings, dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-mesh-')) };
	const { node: local } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
	recordHello(ctx.db, local.id, hello({ publicKey: KEY(1), endpoint: null }));
	const created = nodes.createJoinToken(ctx, { name: 'remote' }, 'http://x');
	const joined = join(
		ctx.db,
		created.token,
		hello({ publicKey: KEY(2), endpoint: 'remote.test:51820' })
	);
	const project = projects.create(ctx, { name: 'Shop' });
	const [env] = environments.list(ctx, project.id);
	return { ctx, local: local.id, remote: joined.nodeId, project, env: env! };
}

function deploy(ctx: Ctx, envId: string) {
	const created = changes.deploy(ctx, envId);
	reconcile(ctx.db, ctx.settings);
	for (const d of created) {
		ctx.db.update(deployment).set({ status: 'active' }).where(eq(deployment.id, d.id)).run();
	}
	return created;
}

describe('mesh in the desired state', () => {
	it('assigns addresses and keeps the endpoint an admin set', () => {
		const { ctx, local, remote } = cluster();
		const rows = ctx.db.select().from(node).all();
		expect(rows.find((r) => r.id === local)!.meshAddress).toBe('10.231.0.1');
		expect(rows.find((r) => r.id === remote)!).toMatchObject({
			meshAddress: '10.231.0.2',
			meshPublicKey: KEY(2),
			meshEndpoint: 'remote.test:51820',
			edge: false
		});
		expect(rows.find((r) => r.id === local)!.edge).toBe(true);

		nodes.update(ctx, local, { meshEndpoint: 'home.test:51820' });
		recordHello(ctx.db, local, hello({ publicKey: KEY(1), endpoint: null }));
		expect(meshMembers(ctx.db).find((m) => m.id === local)!.endpoint).toBe('home.test:51820');
		// the address stays the same across hellos
		expect(meshMembers(ctx.db).find((m) => m.id === local)!.address).toBe('10.231.0.1');
	});

	it('wires an app on one node to Postgres on another, and serves it from the edge', () => {
		const { ctx, local, remote, project, env } = cluster();
		const pg = services.create(ctx, {
			projectId: project.id,
			kind: 'database',
			engine: 'postgres'
		});
		services.stageConfig(ctx, pg.id, env.id, { build: { scan: 'off' }, deploy: { node: remote } });
		const app = services.create(ctx, {
			projectId: project.id,
			kind: 'image',
			source: { type: 'image', image: 'traefik/whoami' }
		});
		services.stageConfig(ctx, app.id, env.id, {
			build: { scan: 'off' },
			networking: { port: 80, publicDomain: true },
			deploy: { node: remote }
		});
		services.stageConfig(ctx, pg.id, env.id, { deploy: { node: remote } });
		const consumer = services.create(ctx, {
			projectId: project.id,
			kind: 'image',
			source: { type: 'image', image: 'alpine' }
		});
		services.stageConfig(ctx, consumer.id, env.id, {
			build: { scan: 'off' },
			deploy: { node: local }
		});
		deploy(ctx, env.id);

		const exports = meshExports(ctx.db, testSecrets);
		expect(exports.map((e) => [e.serviceId, e.nodeId]).sort()).toEqual(
			[
				[pg.id, remote],
				[app.id, remote]
			].sort()
		);
		const ports = meshPorts(exports);

		const onLocal = buildDesiredState(ctx.db, testSecrets, ctx.settings, local);
		expect(onLocal.networks).toContain(meshNetworkName(local));
		expect(onLocal.mesh!.links.map((l) => l.alias).sort()).toEqual([
			expect.stringMatching(/^postgres\./),
			expect.stringMatching(/^whoami\./)
		]);
		// the local node is an edge, so it serves the app's domain through its mesh container
		const domain = ctx.db
			.select()
			.from(serviceInstance)
			.where(eq(serviceInstance.serviceId, app.id))
			.get()!.domain!;
		expect(onLocal.ingress.routes).toContainEqual({
			host: domain,
			upstreams: [`${meshAlias(local)}:${ports.get(`${env.id}:${app.id}`)}`],
			network: meshNetworkName(local)
		});

		const onRemote = buildDesiredState(ctx.db, testSecrets, ctx.settings, remote);
		expect(onRemote.mesh!.forwards.every((f) => f.to === 'local')).toBe(true);
		expect(onRemote.mesh!.links).toEqual([]);
		expect(onRemote.mesh!.peers[0]).toMatchObject({ endpoint: null, keepalive: false });
		expect(onLocal.mesh!.peers[0]).toMatchObject({
			endpoint: 'remote.test:51820',
			keepalive: true
		});
	});

	it('keeps delivering to the live deployment until its replacement is live', () => {
		const { ctx, remote, project, env } = cluster();
		const app = services.create(ctx, {
			projectId: project.id,
			kind: 'image',
			source: { type: 'image', image: 'traefik/whoami' }
		});
		services.stageConfig(ctx, app.id, env.id, {
			build: { scan: 'off' },
			networking: { port: 80 },
			deploy: { node: remote }
		});
		const [first] = deploy(ctx, env.id);
		services.stageConfig(ctx, app.id, env.id, { deploy: { startCommand: 'again' } });
		const [second] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		const target = () =>
			meshExports(ctx.db, testSecrets).find((e) => e.serviceId === app.id)!.target;
		expect(target()).toBe(`${first!.id}.tramline.internal`);

		ctx.db.update(deployment).set({ status: 'active' }).where(eq(deployment.id, second!.id)).run();
		expect(target()).toBe(`${second!.id}.tramline.internal`);
	});

	it('shows each node’s place in the mesh', () => {
		const { ctx, local } = cluster();
		const listed = nodes.list(ctx);
		expect(listed.find((n) => n.id === local)!.mesh).toEqual({
			address: '10.231.0.1',
			endpoint: null,
			unreachable: [],
			relayed: []
		});
		expect(nodes.update(ctx, local, { edge: false }).edge).toBe(false);
		expect(nodes.update(ctx, local, {}).edge).toBe(false);
	});
});

describe('TCP proxy', () => {
	function proxied(allow: string[] = ['203.0.113.0/24']) {
		const ctx = seedCtx();
		ctx.settings = { ...ctx.settings, dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-tcp-')) };
		const { node: local } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
		recordHello(ctx.db, local.id, hello());
		const project = projects.create(ctx, { name: 'Shop' });
		const [env] = environments.list(ctx, project.id);
		const pg = services.create(ctx, {
			projectId: project.id,
			kind: 'database',
			engine: 'postgres'
		});
		services.stageConfig(ctx, pg.id, env!.id, {
			build: { scan: 'off' },
			networking: { tcpProxy: true, tcpAllowlist: allow }
		});
		return { ctx, local: local.id, env: env!, pg, project };
	}

	it('gives Postgres TLS and publishes it on the edge, to the allowlist only', () => {
		const { ctx, local, env, pg } = proxied();
		const [dep] = deploy(ctx, env.id);
		const port = ctx.db
			.select()
			.from(serviceInstance)
			.where(eq(serviceInstance.serviceId, pg.id))
			.get()!.tcpPort!;
		expect(port).toBe(30_000);

		const desired = buildDesiredState(ctx.db, testSecrets, ctx.settings, local);
		expect(desired.containers[0]!.tls).toEqual({
			kind: 'postgres',
			names: ['postgres.production.tramline.internal', 'localhost']
		});
		expect(desired.tcpProxies).toEqual([
			{
				name: `tl-tcp-${env.id}-${pg.id}`,
				port: 30_000,
				protocol: 'postgres',
				allow: ['203.0.113.0/24'],
				target: `${dep!.id}.tramline.internal:5432`,
				network: networkName(env.id)
			}
		]);

		// a non-edge node publishes nothing
		nodes.update(ctx, local, { edge: false });
		expect(buildDesiredState(ctx.db, testSecrets, ctx.settings, local).tcpProxies).toEqual([]);
	});

	it('keeps the port across deploys and gives each service its own', () => {
		const { ctx, env, project } = proxied();
		deploy(ctx, env.id);
		const other = services.create(ctx, {
			projectId: project.id,
			kind: 'database',
			engine: 'postgres'
		});
		services.stageConfig(ctx, other.id, env.id, {
			build: { scan: 'off' },
			networking: { tcpProxy: true, tcpAllowlist: ['0.0.0.0/0'] }
		});
		deploy(ctx, env.id);
		expect(
			ctx.db
				.select({ port: serviceInstance.tcpPort })
				.from(serviceInstance)
				.all()
				.map((r) => r.port)
				.sort()
		).toEqual([30_000, 30_001]);
	});

	it('refuses to open without an allowlist, or for anything but Postgres', () => {
		const { ctx, env, project } = proxied([]);
		expect(() => changes.deploy(ctx, env.id)).toThrow('list the addresses the TCP proxy');
		services.stageConfig(ctx, services.list(ctx, project.id)[0]!.id, env.id, {
			networking: { tcpAllowlist: ['198.51.100.7'] }
		});
		const app = services.create(ctx, {
			projectId: project.id,
			kind: 'image',
			source: { type: 'image', image: 'traefik/whoami' }
		});
		services.stageConfig(ctx, app.id, env.id, {
			networking: { port: 80, tcpProxy: true, tcpAllowlist: ['0.0.0.0/0'] }
		});
		expect(() => changes.deploy(ctx, env.id)).toThrow('supports Postgres only');
	});
});
