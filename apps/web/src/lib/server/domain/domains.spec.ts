import { AddCustomDomain, type AgentHello } from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import {
	customDomain,
	installAdmin,
	node as nodeTable,
	publicTunnel,
	serviceInstance
} from '../db/schema';
import { buildDesiredState, containerName } from '../nodes/desired';
import { reconcile } from '../nodes/reconciler';
import { ensureLocalNode, recordHello, recordReport } from '../nodes/registry';
import { grantInstallAdmin, seedCtx, testSecrets } from '../testing';
import * as changes from './changes';
import * as domains from './domains';
import * as environments from './environments';
import * as projects from './projects';
import * as publicAccess from './public-access';
import * as services from './services';

const hello: AgentHello = {
	protocol: 1,
	agentVersion: 'test',
	hostname: 'box',
	os: 'linux',
	arch: 'arm64',
	cpus: 4,
	memoryMb: 8192,
	docker: { version: '27.0.0' },
	features: ['tunnel', 'tunnel-routes']
};

/** A live whoami on port 80 with a generated public domain. */
function setup(db?: Db) {
	const ctx = seedCtx(db);
	ctx.settings = {
		...ctx.settings,
		baseDomain: 'apps.example.com',
		publicUrl: 'https://tramline.example.com',
		dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-dom-'))
	};
	const { node } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
	recordHello(ctx.db, node.id, hello);
	const project = projects.create(ctx, { name: 'Shop' });
	const [env] = environments.list(ctx, project.id);
	const svc = services.create(ctx, {
		projectId: project.id,
		kind: 'image',
		source: { type: 'image', image: 'traefik/whoami' }
	});
	services.stageConfig(ctx, svc.id, env!.id, {
		networking: { port: 80, publicDomain: true },
		build: { scan: 'off' }
	});
	const [dep] = changes.deploy(ctx, env!.id);
	reconcile(ctx.db, ctx.settings);
	recordReport(ctx.db, node.id, {
		revision: null,
		containers: [
			{
				name: containerName(dep!.id, 0),
				deploymentId: dep!.id,
				replica: 0,
				state: 'running',
				healthy: null,
				exitCode: null,
				restartCount: 0,
				error: null,
				startedAt: new Date(Date.now() - 10_000).toISOString()
			}
		]
	});
	reconcile(ctx.db, ctx.settings);
	const ingress = () => buildDesiredState(ctx.db, testSecrets, ctx.settings, node.id).ingress;
	const routes = () => ingress().routes;
	return { ctx, env: env!, svc, dep: dep!, routes, ingress, nodeId: node.id };
}

const notFound = Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });

describe('Hostname', () => {
	it.each([
		['App.Example.com.', 'app.example.com'],
		['  shop.example.co.uk ', 'shop.example.co.uk']
	])('accepts %s as %s', (input, expected) => {
		expect(
			AddCustomDomain.parse({ serviceId: 's', environmentId: 'e', hostname: input }).hostname
		).toBe(expected);
	});

	it.each(['localhost', 'no_underscores.com', '-bad.example.com', '10.0.0.1', 'http://x.com'])(
		'refuses %s',
		(hostname) => {
			expect(
				AddCustomDomain.safeParse({ serviceId: 's', environmentId: 'e', hostname }).success
			).toBe(false);
		}
	);
});

describe('custom domains', () => {
	it('stays pending, and unrouted, until the TXT record proves ownership', async () => {
		const { ctx, env, svc, routes } = setup();
		const resolveTxt = vi.fn<domains.ResolveTxt>(async () => {
			throw notFound;
		});
		const added = await domains.add(
			ctx,
			{ serviceId: svc.id, environmentId: env.id, hostname: 'Shop.Example.com' },
			resolveTxt
		);
		expect(added).toMatchObject({
			hostname: 'shop.example.com',
			status: 'pending',
			verification: {
				name: '_tramline.shop.example.com',
				value: expect.stringMatching(/^tramline-verify=[0-9a-f]{32}$/)
			},
			target: expect.stringMatching(/^whoami-[0-9a-f]{6}\.apps\.example\.com$/),
			error: 'No TXT record at _tramline.shop.example.com yet'
		});
		expect(resolveTxt).toHaveBeenCalledWith('_tramline.shop.example.com');
		expect(routes().map((r) => r.host)).not.toContain('shop.example.com');

		// a record that doesn't match isn't enough
		resolveTxt.mockResolvedValueOnce([['tramline-verify=someone-else']]);
		expect((await domains.verify(ctx, added.id, resolveTxt)).error).toBe(
			"The TXT record at _tramline.shop.example.com doesn't match yet"
		);

		// long TXT records arrive in chunks
		const value = added.verification.value;
		resolveTxt.mockResolvedValueOnce([[value.slice(0, 10), value.slice(10)]]);
		const verified = await domains.verify(ctx, added.id, resolveTxt);
		expect(verified).toMatchObject({ status: 'verified', error: null });
		expect(routes()).toContainEqual(
			expect.objectContaining({ host: 'shop.example.com', custom: true })
		);
		// once verified, it stays verified
		resolveTxt.mockRejectedValueOnce(notFound);
		expect((await domains.verify(ctx, added.id, resolveTxt)).status).toBe('verified');

		expect(domains.list(ctx, svc.id, env.id).map((d) => d.hostname)).toEqual(['shop.example.com']);
		await domains.remove(ctx, added.id);
		expect(routes().map((r) => r.host)).not.toContain('shop.example.com');
	});

	it('verifies .localhost names straight away, for local development', async () => {
		const { ctx, env, svc, routes } = setup();
		const resolveTxt = vi.fn<domains.ResolveTxt>();
		const added = await domains.add(
			ctx,
			{ serviceId: svc.id, environmentId: env.id, hostname: 'shop.localhost' },
			resolveTxt
		);
		expect(added.status).toBe('verified');
		expect(resolveTxt).not.toHaveBeenCalled();
		expect(routes().map((r) => r.host)).toContain('shop.localhost');
	});

	it('refuses generated names, Tramline itself, and names already in use', async () => {
		const { ctx, env, svc } = setup();
		const add = (hostname: string) =>
			domains.add(ctx, { serviceId: svc.id, environmentId: env.id, hostname }, async () => []);
		await expect(add('evil.apps.example.com')).rejects.toThrow(
			'Names under apps.example.com are generated by Tramline'
		);
		await expect(add('tramline.example.com')).rejects.toThrow(
			'That is the address of Tramline itself'
		);
		await add('shop.example.com');
		// even from another organization
		const other = setup(ctx.db);
		await expect(
			domains.add(
				other.ctx,
				{ serviceId: other.svc.id, environmentId: other.env.id, hostname: 'shop.example.com' },
				async () => []
			)
		).rejects.toThrow('shop.example.com is already in use');
	});

	it('refuses another service’s generated name on a local install', async () => {
		const { ctx, env, svc } = setup();
		ctx.settings = { ...ctx.settings, baseDomain: 'localhost' };
		ctx.db.update(serviceInstance).set({ domain: 'whoami-abc123.localhost' }).run();
		await expect(
			domains.add(
				ctx,
				{
					serviceId: svc.id,
					environmentId: env.id,
					hostname: 'whoami-abc123.localhost'
				},
				async () => []
			)
		).rejects.toThrow('whoami-abc123.localhost is already in use');
		expect(
			(
				await domains.add(
					ctx,
					{ serviceId: svc.id, environmentId: env.id, hostname: 'shop.localhost' },
					async () => []
				)
			).status
		).toBe('verified');
	});

	it('reports lookup failures', async () => {
		const { ctx, env, svc } = setup();
		const added = await domains.add(
			ctx,
			{ serviceId: svc.id, environmentId: env.id, hostname: 'shop.example.com' },
			async () => {
				throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
			}
		);
		expect(added.error).toBe("Couldn't look up _tramline.shop.example.com: ETIMEOUT");
	});

	it('keeps other organizations out', async () => {
		const { ctx, env, svc } = setup();
		const added = await domains.add(
			ctx,
			{ serviceId: svc.id, environmentId: env.id, hostname: 'shop.example.com' },
			async () => []
		);
		const other = seedCtx(ctx.db);
		await expect(domains.verify(other, added.id, async () => [])).rejects.toThrow(
			'Domain not found'
		);
		await expect(domains.remove(other, added.id)).rejects.toThrow('Domain not found');
	});

	it('re-checks pending domains in the background for a week', async () => {
		const { ctx, env, svc } = setup();
		const added = await domains.add(
			ctx,
			{ serviceId: svc.id, environmentId: env.id, hostname: 'shop.example.com' },
			async () => []
		);
		const resolveTxt = vi.fn<domains.ResolveTxt>(async () => [[added.verification.value]]);
		const soon = new Date(Date.now() + 60_000);
		// checked a moment ago: not due yet
		expect(await domains.recheckDomains(ctx.db, { now: soon, resolveTxt })).toBe(0);
		const later = new Date(Date.now() + domains.RECHECK_MS + 1000);
		expect(await domains.recheckDomains(ctx.db, { now: later, resolveTxt })).toBe(1);
		expect(domains.list(ctx, svc.id, env.id)[0]!.status).toBe('verified');

		// a domain left pending for over a week is no longer checked
		const stale = await domains.add(
			ctx,
			{ serviceId: svc.id, environmentId: env.id, hostname: 'old.example.com' },
			async () => []
		);
		ctx.db
			.update(customDomain)
			.set({ createdAt: new Date(Date.now() - domains.GIVE_UP_MS - 1000) })
			.where(eq(customDomain.id, stale.id))
			.run();
		expect(await domains.recheckDomains(ctx.db, { now: later, resolveTxt })).toBe(0);
	});
});

/** Just enough of Cloudflare's DNS and tunnel APIs, with what was asked of them. */
function fakeCloudflare() {
	const records = new Map<string, { name: string; content: string }>();
	const state = { records, ingress: [] as { hostname?: string; service: string }[], fail: false };
	let next = 1;
	const ok = (result: unknown) => Response.json({ success: true, result });
	const fetcher = (async (input: string | URL, init?: RequestInit) => {
		if (state.fail) throw new Error('connection refused');
		const url = new URL(String(input));
		const method = init?.method ?? 'GET';
		const path = url.pathname.replace('/client/v4', '');
		if (path === '/zones/zone_1/dns_records' && method === 'GET') {
			return ok([...records.values()].filter((r) => r.name === url.searchParams.get('name')));
		}
		if (path === '/zones/zone_1/dns_records' && method === 'POST') {
			const body = JSON.parse(String(init!.body)) as { name: string; content: string };
			const id = `rec_${next++}`;
			records.set(id, { name: body.name, content: body.content });
			return ok({ id });
		}
		const record = path.match(/^\/zones\/zone_1\/dns_records\/(.+)$/);
		if (record && method === 'DELETE') {
			records.delete(record[1]!);
			return ok({ id: record[1] });
		}
		if (path === '/accounts/acct_1/cfd_tunnel/tun_1/configurations' && method === 'PUT') {
			state.ingress = (
				JSON.parse(String(init!.body)) as { config: { ingress: typeof state.ingress } }
			).config.ingress;
			return ok({});
		}
		return new Response(null, { status: 404 });
	}) as typeof fetch;
	return { state, fetcher };
}

/** The setup above, plus a tunnel on home.example whose connector runs on the node. */
function withTunnel() {
	const base = setup();
	grantInstallAdmin(base.ctx);
	base.ctx.db
		.insert(publicTunnel)
		.values({
			id: 'tunnel_1',
			provider: 'cloudflare',
			hostname: 'tramline.home.example',
			apiToken: testSecrets.encrypt('cf-token'),
			accountId: 'acct_1',
			zoneId: 'zone_1',
			zoneName: 'home.example',
			tunnelId: 'tun_1',
			dnsRecordId: 'rec_tunnel',
			tunnelToken: testSecrets.encrypt('eyJ-tunnel'),
			originUrl: 'http://192.168.1.10:3000',
			nodeId: base.nodeId
		})
		.run();
	return { ...base, ...fakeCloudflare() };
}

describe('domains through the tunnel', () => {
	it('are live at once: Tramline makes the DNS record and the route, and serves them only on the tunnel listener', async () => {
		const { ctx, env, svc, ingress, state, fetcher } = withTunnel();
		const added = await domains.add(
			ctx,
			{ serviceId: svc.id, environmentId: env.id, hostname: 'api.home.example', route: 'tunnel' },
			() => Promise.reject(new Error('no TXT lookups for tunnel domains')),
			fetcher
		);
		expect(added).toMatchObject({
			hostname: 'api.home.example',
			route: 'tunnel',
			status: 'verified'
		});
		expect([...state.records.values()]).toEqual([
			{ name: 'api.home.example', content: 'tun_1.cfargotunnel.com' }
		]);
		// nodes' own route first, then the service, then nothing else
		expect(state.ingress).toEqual([
			expect.objectContaining({
				hostname: 'tramline.home.example',
				service: 'http://192.168.1.10:3000'
			}),
			{
				hostname: 'api.home.example',
				service: `http://127.0.0.1:${publicAccess.TUNNEL_INGRESS_PORT}`
			},
			{ service: 'http_status:404' }
		]);
		// never on the main listener, which would try to get it a certificate
		expect(ingress().routes.map((r) => r.host)).not.toContain('api.home.example');
		expect(ingress().tunnel).toEqual({
			port: publicAccess.TUNNEL_INGRESS_PORT,
			routes: [expect.objectContaining({ host: 'api.home.example', custom: true })]
		});
	});

	it('refuses names it can’t or shouldn’t publish', async () => {
		const { ctx, env, svc, state, fetcher } = withTunnel();
		const add = (hostname: string) =>
			domains.add(
				ctx,
				{ serviceId: svc.id, environmentId: env.id, hostname, route: 'tunnel' },
				undefined,
				fetcher
			);
		await expect(add('api.elsewhere.example')).rejects.toThrow('home.example or a name under it');
		await expect(add('tramline.home.example')).rejects.toThrow('the tunnel');
		state.records.set('rec_x', { name: 'taken.home.example', content: '1.2.3.4' });
		await expect(add('taken.home.example')).rejects.toThrow('already has a DNS record');

		// the connector's agent can't serve them
		ctx.db
			.update(nodeTable)
			.set({ info: { ...hello, features: ['tunnel'] } })
			.run();
		await expect(add('api.home.example')).rejects.toThrow('too old to serve services');
		// or nobody's node runs it
		ctx.db.update(publicTunnel).set({ nodeId: null }).run();
		await expect(add('api.home.example')).rejects.toThrow('when a node runs its connector');
		expect(ctx.db.select().from(customDomain).all()).toEqual([]);
	});

	it('is only for install admins', async () => {
		const { ctx, env, svc, fetcher } = withTunnel();
		ctx.db.delete(installAdmin).run();
		await expect(
			domains.add(
				ctx,
				{ serviceId: svc.id, environmentId: env.id, hostname: 'api.home.example', route: 'tunnel' },
				undefined,
				fetcher
			)
		).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('takes the route and record away again, including for a domain deleted with its service', async () => {
		const { ctx, env, svc, ingress, state, fetcher } = withTunnel();
		const add = (hostname: string) =>
			domains.add(
				ctx,
				{ serviceId: svc.id, environmentId: env.id, hostname, route: 'tunnel' },
				undefined,
				fetcher
			);
		const api = await add('api.home.example');
		await add('www.home.example');

		await domains.remove(ctx, api.id, fetcher);
		expect([...state.records.values()].map((r) => r.name)).toEqual(['www.home.example']);
		expect(state.ingress.map((r) => r.hostname)).toEqual([
			'tramline.home.example',
			'www.home.example',
			undefined
		]);

		// gone without domains.remove, as when its service is deleted
		ctx.db.delete(customDomain).run();
		expect(ingress().tunnel).toBeUndefined();
		await publicAccess.reconcileTunnel(ctx.db, testSecrets, { fetcher });
		expect(state.records.size).toBe(0);
		expect(state.ingress.map((r) => r.hostname)).toEqual(['tramline.home.example', undefined]);
		expect(ctx.db.select().from(publicTunnel).get()!.appRecords).toEqual({});

		// with nothing stale, the timer leaves Cloudflare alone
		state.fail = true;
		await publicAccess.reconcileTunnel(ctx.db, testSecrets, { fetcher });
	});

	it('keeps the connector on a node that can serve them', async () => {
		const { ctx, env, svc, fetcher } = withTunnel();
		await domains.add(
			ctx,
			{ serviceId: svc.id, environmentId: env.id, hostname: 'api.home.example', route: 'tunnel' },
			undefined,
			fetcher
		);
		await expect(publicAccess.update(ctx, { nodeId: null }, fetcher)).rejects.toThrow(
			'api.home.example is published through the tunnel'
		);
	});

	it('removing the tunnel unpublishes them', async () => {
		const { ctx, env, svc, state, fetcher } = withTunnel();
		await domains.add(
			ctx,
			{ serviceId: svc.id, environmentId: env.id, hostname: 'api.home.example', route: 'tunnel' },
			undefined,
			fetcher
		);
		await publicAccess.remove(ctx, { force: true }, fetcher);
		expect(state.records.size).toBe(0);
		expect(ctx.db.select().from(customDomain).all()).toEqual([]);
	});
});
