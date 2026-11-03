import { ListCloudflareZones, type AgentHello } from '@tramline/contracts';
import { describe, expect, it } from 'vitest';
import { publicTunnel } from '../db/schema';
import { buildDesiredState } from '../nodes/desired';
import { join } from '../nodes/registry';
import { grantInstallAdmin, seedCtx } from '../testing';
import type { Ctx } from './context';
import * as nodes from './nodes';
import * as publicAccess from './public-access';

const TOKEN = 'cf-api-token-0123456789abcdef';

const hello: AgentHello = {
	protocol: 1,
	agentVersion: 'test',
	hostname: 'box',
	os: 'linux',
	arch: 'amd64',
	cpus: 2,
	memoryMb: 4096,
	docker: { version: '27.0.0' },
	gpus: []
};

/** Just enough of Cloudflare's API, with what it was asked to do. */
function fakeCloudflare({ failDns = false, existing = [] as string[] } = {}) {
	const state = {
		tunnels: new Map<string, { name: string; config?: unknown }>(),
		records: new Map<string, { name: string; content: string; proxied: boolean }>(),
		calls: [] as string[]
	};
	let next = 0;
	const ok = (result: unknown, extra = {}) =>
		Response.json({ success: true, errors: [], result, ...extra });
	const fetcher = (async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? 'GET';
		const path = url.pathname.replace('/client/v4', '');
		state.calls.push(`${method} ${path}`);
		if (new Headers(init?.headers).get('authorization') !== `Bearer ${TOKEN}`) {
			return Response.json(
				{ success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
				{ status: 403 }
			);
		}
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		const zone = { id: 'zone_1', name: 'tramline-dev.com', account: { id: 'acc_1', name: 'Joe' } };
		if (path === '/zones') return ok([zone], { result_info: { page: 1, total_pages: 1 } });
		if (path === '/zones/zone_1') return ok(zone);
		if (path === '/zones/zone_1/dns_records' && method === 'GET') {
			const name = url.searchParams.get('name')!;
			const taken =
				existing.includes(name) || [...state.records.values()].some((r) => r.name === name);
			return ok(taken ? [{ id: 'other' }] : []);
		}
		if (path === '/zones/zone_1/dns_records' && method === 'POST') {
			if (failDns) {
				return Response.json(
					{ success: false, errors: [{ code: 81053, message: 'Record already exists' }] },
					{ status: 400 }
				);
			}
			const id = `rec_${++next}`;
			state.records.set(id, body);
			return ok({ id });
		}
		const record = path.match(/^\/zones\/zone_1\/dns_records\/(.+)$/);
		if (record && method === 'DELETE') {
			if (!state.records.delete(record[1]!)) return new Response(null, { status: 404 });
			return ok({ id: record[1] });
		}
		if (path === '/accounts/acc_1/cfd_tunnel' && method === 'POST') {
			const id = `tun_${++next}`;
			state.tunnels.set(id, { name: body.name });
			return ok({ id });
		}
		const tunnel = path.match(/^\/accounts\/acc_1\/cfd_tunnel\/([^/]+)(\/.*)?$/);
		if (tunnel) {
			const [, id, rest = ''] = tunnel;
			const found = state.tunnels.get(id!);
			if (!found) return new Response(null, { status: 404 });
			if (rest === '/configurations' && method === 'PUT') {
				found.config = body.config;
				return ok({});
			}
			if (rest === '/token') return ok(`eyJ-${id}`);
			if (rest === '/connections') return ok(null);
			if (rest === '' && method === 'GET') return ok({ id, status: 'healthy' });
			if (rest === '' && method === 'DELETE') {
				state.tunnels.delete(id!);
				return ok({ id });
			}
		}
		return new Response(null, { status: 404 });
	}) as typeof fetch;
	return { state, fetcher };
}

function setup() {
	const ctx = grantInstallAdmin(seedCtx());
	const enroll = (name: string) => {
		const { token } = nodes.createJoinToken(ctx, { name }, 'http://192.168.1.10:3000');
		return join(ctx.db, token, { ...hello, hostname: name }).nodeId;
	};
	return { ctx, home: enroll('home'), other: enroll('other') };
}

const create = (ctx: Ctx, fetcher: typeof fetch, nodeId: string | null) =>
	publicAccess.create(
		ctx,
		{
			apiToken: TOKEN,
			zoneId: 'zone_1',
			subdomain: 'tramline',
			originUrl: 'http://localhost:3000',
			nodeId
		},
		fetcher
	);

const desired = (ctx: Ctx, nodeId: string) =>
	buildDesiredState(ctx.db, ctx.secrets, ctx.settings, nodeId);

describe('public access', () => {
	it('takes the token out of what people paste', () => {
		const parse = (apiToken: string) => ListCloudflareZones.safeParse({ apiToken });
		expect(parse(` ${TOKEN}\n`).data?.apiToken).toBe(TOKEN);
		expect(parse(`cf-api-token-\n0123456789abcdef`).data?.apiToken).toBe(TOKEN);
		expect(
			parse(
				`curl "https://api.cloudflare.com/client/v4/user/tokens/verify" \\\n -H "Authorization: Bearer ${TOKEN}"`
			).data?.apiToken
		).toBe(TOKEN);
		expect(parse('not a token at all, really!').success).toBe(false);
	});

	it('lists the domains a token can manage, and explains a refused token', async () => {
		const { ctx } = setup();
		const { fetcher } = fakeCloudflare();
		expect(await publicAccess.zones(ctx, { apiToken: TOKEN }, fetcher)).toEqual([
			{ id: 'zone_1', name: 'tramline-dev.com', accountId: 'acc_1', accountName: 'Joe' }
		]);
		await expect(
			publicAccess.zones(ctx, { apiToken: 'wrong-token-0123456789' }, fetcher)
		).rejects.toMatchObject({ code: 'validation_failed', message: /refused the API token/ });
	});

	it('creates a tunnel that only carries the agent API, and new nodes join through it', async () => {
		const { ctx, home, other } = setup();
		const { state, fetcher } = fakeCloudflare();
		const before = nodes.createJoinToken(ctx, { name: 'before' }, 'http://192.168.1.10:3000');
		expect(before.command).toContain('--url http://localhost:5173');

		const access = await create(ctx, fetcher, home);
		expect(access).toMatchObject({
			agentUrl: 'https://tramline.tramline-dev.com',
			source: 'tunnel',
			tunnel: { hostname: 'tramline.tramline-dev.com', nodeName: 'home', status: 'healthy' }
		});

		const [tunnelId, tunnel] = [...state.tunnels][0]!;
		expect(tunnel.config).toEqual({
			ingress: [
				{
					hostname: 'tramline.tramline-dev.com',
					path: '^/(api/agent/|install\\.sh$)',
					service: 'http://localhost:3000'
				},
				{ service: 'http_status:404' }
			]
		});
		expect([...state.records.values()]).toEqual([
			expect.objectContaining({
				name: 'tramline.tramline-dev.com',
				content: `${tunnelId}.cfargotunnel.com`,
				proxied: true
			})
		]);

		// secrets are stored encrypted
		const row = ctx.db.select().from(publicTunnel).get()!;
		expect(row.apiToken).not.toContain(TOKEN);
		expect(row.tunnelToken).not.toContain('eyJ');

		// the chosen node runs the connector; no other node does
		expect(desired(ctx, home).tunnel).toEqual({
			name: `tramline-tunnel-${home}`,
			image: publicAccess.TUNNEL_IMAGE,
			token: `eyJ-${tunnelId}`
		});
		expect(desired(ctx, other).tunnel).toBeNull();

		const after = nodes.createJoinToken(ctx, { name: 'after' }, 'http://192.168.1.10:3000');
		expect(after.command).toBe(
			`curl -fsSL https://tramline.tramline-dev.com/install.sh | sudo sh -s -- --url https://tramline.tramline-dev.com --token ${after.token}`
		);
		await expect(create(ctx, fetcher, home)).rejects.toMatchObject({ code: 'conflict' });
	});

	it('won’t take over a name that already has a DNS record', async () => {
		const { ctx, home } = setup();
		const { state, fetcher } = fakeCloudflare({ existing: ['tramline.tramline-dev.com'] });
		await expect(create(ctx, fetcher, home)).rejects.toMatchObject({
			code: 'conflict',
			message: /already has a DNS record/
		});
		expect(state.tunnels.size).toBe(0);
	});

	it('removes the tunnel again when a later step fails', async () => {
		const { ctx, home } = setup();
		const { state, fetcher } = fakeCloudflare({ failDns: true });
		await expect(create(ctx, fetcher, home)).rejects.toMatchObject({
			message: /Cloudflare couldn’t create the DNS record: Record already exists/
		});
		expect(state.tunnels.size).toBe(0);
		expect(ctx.db.select().from(publicTunnel).all()).toEqual([]);
	});

	it('moves the connector and changes its origin', async () => {
		const { ctx, home, other } = setup();
		const { state, fetcher } = fakeCloudflare();
		await create(ctx, fetcher, home);

		const moved = await publicAccess.update(
			ctx,
			{ nodeId: other, originUrl: 'http://10.0.0.5:3000' },
			fetcher
		);
		expect(moved.tunnel).toMatchObject({ nodeName: 'other', originUrl: 'http://10.0.0.5:3000' });
		expect(desired(ctx, home).tunnel).toBeNull();
		expect(desired(ctx, other).tunnel?.name).toBe(`tramline-tunnel-${other}`);
		const [tunnel] = [...state.tunnels.values()];
		expect((tunnel!.config as { ingress: { service: string }[] }).ingress[0]!.service).toBe(
			'http://10.0.0.5:3000'
		);

		// run by hand: no node runs it, and the command carries the token
		await publicAccess.update(ctx, { nodeId: null }, fetcher);
		expect(desired(ctx, other).tunnel).toBeNull();
		const { command, token } = publicAccess.connector(ctx);
		expect(token).toMatch(/^eyJ-/);
		expect(command).toContain(`tunnel --no-autoupdate run --token ${token}`);
	});

	it('deletes the tunnel and its DNS record, or forgets them when Cloudflare can’t', async () => {
		const { ctx, home } = setup();
		const { state, fetcher } = fakeCloudflare();
		await create(ctx, fetcher, home);
		await publicAccess.remove(ctx, {}, fetcher);
		expect(state.tunnels.size).toBe(0);
		expect(state.records.size).toBe(0);
		expect(desired(ctx, home).tunnel).toBeNull();
		expect((await publicAccess.get(ctx, fetcher)).source).toBe('env');

		await create(ctx, fetcher, home);
		const broken = (async () => {
			throw new Error('network down');
		}) as typeof fetch;
		await expect(publicAccess.remove(ctx, {}, broken)).rejects.toMatchObject({
			message: /Couldn’t reach Cloudflare/
		});
		await publicAccess.remove(ctx, { force: true }, broken);
		expect(ctx.db.select().from(publicTunnel).all()).toEqual([]);
	});

	it('is for install admins only', async () => {
		const ctx = seedCtx();
		const { fetcher } = fakeCloudflare();
		await expect(publicAccess.get(ctx, fetcher)).rejects.toMatchObject({ code: 'forbidden' });
		await expect(publicAccess.zones(ctx, { apiToken: TOKEN }, fetcher)).rejects.toMatchObject({
			code: 'forbidden'
		});
		expect(() => publicAccess.connector(ctx)).toThrow(/install's admins/);
	});
});
