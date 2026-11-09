import type { AccessEntry } from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDesiredState } from '../nodes/desired';
import { ensureLocalNode } from '../nodes/registry';
import { accessLog, customDomain, member, node, serviceInstance } from '../db/schema';
import * as environments from '../domain/environments';
import * as projects from '../domain/projects';
import * as services from '../domain/services';
import * as traffic from '../domain/traffic';
import { DEFAULT_TRAFFIC, type PlatformSettings } from '../settings';
import { seedCtx, testSecrets, testSettings } from '../testing';
import { pruneAccessLogs, recordAccess, Sampler, SAMPLE_AFTER, SAMPLE_EVERY } from './store';

const NOW = Date.UTC(2027, 0, 15, 8, 30);
const at = (msAgo = 0) => new Date(NOW - msAgo).toISOString();

const http = (overrides: Partial<Extract<AccessEntry, { kind: 'http' }>> = {}): AccessEntry => ({
	kind: 'http',
	ts: at(),
	host: 'shop.apps.example.com',
	method: 'GET',
	path: '/',
	status: 200,
	durationMs: 3,
	bytes: 100,
	client: '8.8.8.8',
	userAgent: 'curl/8',
	tunnel: false,
	...overrides
});

const tcp = (overrides: Partial<Extract<AccessEntry, { kind: 'tcp' }>> = {}): AccessEntry => ({
	kind: 'tcp',
	ts: at(),
	port: 15432,
	client: '203.0.113.9',
	outcome: 'refused',
	durationMs: 1,
	bytesIn: 0,
	bytesOut: 0,
	...overrides
});

const NETWORKS: Record<string, { asn: number; name: string }> = {
	'8.8.8.8': { asn: 15169, name: 'GOOGLE' },
	'8.8.4.4': { asn: 15169, name: 'GOOGLE' },
	'203.0.113.9': { asn: 64500, name: 'EXAMPLE-HOSTING' }
};
const lookup = (address: string) => NETWORKS[address] ?? null;

/** A service with a generated domain, a TCP port and a verified custom domain, on a node. */
function setup() {
	const ctx = seedCtx();
	const project = projects.create(ctx, { name: 'Shop' });
	const env = environments.list(ctx, project.id)[0]!;
	const svc = services.create(ctx, {
		projectId: project.id,
		kind: 'image',
		source: { type: 'image', image: 'nginx' }
	});
	ctx.db
		.insert(serviceInstance)
		.values({
			serviceId: svc.id,
			environmentId: env.id,
			domain: 'shop.apps.example.com',
			tcpPort: 15432
		})
		.onConflictDoUpdate({
			target: [serviceInstance.serviceId, serviceInstance.environmentId],
			set: { domain: 'shop.apps.example.com', tcpPort: 15432 }
		})
		.run();
	for (const [hostname, status] of [
		['shop.example.org', 'verified'],
		['pending.example.org', 'pending']
	] as const) {
		ctx.db
			.insert(customDomain)
			.values({
				id: `cd_${hostname}`,
				serviceId: svc.id,
				environmentId: env.id,
				hostname,
				token: 't',
				status,
				createdAt: new Date()
			} as typeof customDomain.$inferInsert)
			.run();
	}
	ctx.db
		.insert(node)
		.values({
			id: 'node_edge',
			name: 'edge-1',
			tokenHash: 'x',
			createdAt: new Date()
		} as typeof node.$inferInsert)
		.run();
	const record = (entries: AccessEntry[], settings: Partial<typeof DEFAULT_TRAFFIC> = {}) =>
		recordAccess(ctx.db, 'node_edge', entries, {
			settings: { ...DEFAULT_TRAFFIC, ...settings },
			lookup,
			sampler: new Sampler(),
			now: NOW
		});
	const query = (params: Record<string, string> = {}) =>
		traffic.serviceTraffic(
			ctx,
			svc.id,
			{ environmentId: env.id, ...params },
			{ networks: true },
			NOW
		);
	return { ctx, env, svc, record, query };
}

describe('recording traffic', () => {
	it('files each entry under the service its host or port belongs to', () => {
		const { ctx, svc, env, record } = setup();
		const stored = record([
			http(),
			http({ host: 'shop.example.org', path: '/custom' }),
			// unverified custom domains, unknown hosts and ports own nothing
			http({ host: 'pending.example.org' }),
			http({ host: '192.0.2.10' }),
			tcp(),
			tcp({ port: 9999 }),
			// outside retention, or from a clock far in the future
			http({ ts: at(15 * 86_400_000) }),
			http({ ts: new Date(NOW + 2 * 3_600_000).toISOString() })
		]);
		expect(stored).toBe(3);
		const rows = ctx.db.select().from(accessLog).all();
		expect(rows.every((r) => r.serviceId === svc.id && r.environmentId === env.id)).toBe(true);
		expect(rows.map((r) => [r.kind, r.path ?? r.outcome, r.network, r.nodeId])).toEqual([
			['http', '/', 'GOOGLE', 'node_edge'],
			['http', '/custom', 'GOOGLE', 'node_edge'],
			['tcp', 'refused', 'EXAMPLE-HOSTING', 'node_edge']
		]);
	});

	it('keeps nothing when retention is 0, and anonymises after looking up the network', () => {
		const { ctx, record } = setup();
		expect(record([http()], { retentionDays: 0 })).toBe(0);
		expect(record([], {})).toBe(0);
		record([http(), tcp()], { anonymize: true });
		expect(
			ctx.db
				.select()
				.from(accessLog)
				.all()
				.map((r) => [r.client, r.asn])
		).toEqual([
			['8.8.8.0', 15169],
			['203.0.113.0', 64500]
		]);
	});

	it('samples successes on a busy service, never errors or connections', () => {
		const sampler = new Sampler();
		const target = { serviceId: 's', environmentId: 'e' };
		const weights = Array.from({ length: SAMPLE_AFTER + 2 * SAMPLE_EVERY }, () =>
			sampler.weigh(target, http())
		);
		expect(weights.slice(0, SAMPLE_AFTER).every((w) => w === 1)).toBe(true);
		const rest = weights.slice(SAMPLE_AFTER);
		expect(rest.filter((w) => w === SAMPLE_EVERY)).toHaveLength(2);
		expect(rest.filter((w) => w === 0)).toHaveLength(2 * SAMPLE_EVERY - 2);
		expect(sampler.weigh(target, http({ status: 404 }))).toBe(1);
		expect(sampler.weigh(target, tcp())).toBe(1);
		// a new minute starts counting again
		expect(sampler.weigh(target, http({ ts: new Date(NOW + 60_000).toISOString() }))).toBe(1);
	});

	it('prunes by age, then by the row cap', () => {
		const { ctx, record } = setup();
		record([http({ ts: at(3 * 86_400_000) }), http({ ts: at(86_400_000) }), http(), http()]);
		pruneAccessLogs(ctx.db, { retentionDays: 2, maxRows: 10 }, NOW);
		expect(ctx.db.select().from(accessLog).all()).toHaveLength(3);
		pruneAccessLogs(ctx.db, { retentionDays: 2, maxRows: 2 }, NOW);
		const left = ctx.db.select().from(accessLog).all();
		expect(left).toHaveLength(2);
		expect(left.every((r) => r.at.getTime() === NOW)).toBe(true);
		pruneAccessLogs(ctx.db, { retentionDays: 0, maxRows: 2 }, NOW + 1);
		expect(ctx.db.select().from(accessLog).all()).toHaveLength(0);
	});
});

describe('the Traffic tab', () => {
	function seeded() {
		const s = setup();
		s.record([
			http({ ts: at(2 * 3_600_000), path: '/old' }),
			http({ path: '/.env', status: 404, client: '203.0.113.9', userAgent: 'zgrab' }),
			http({ path: '/wp-admin/', status: 404, client: '203.0.113.9' }),
			http({ path: '/100%_off', client: '8.8.4.4' }),
			http({ path: '/api', status: 503 }),
			http({ path: '/login', status: 302 }),
			tcp(),
			tcp({ outcome: 'proxied', bytesIn: 10, bytesOut: 20, client: '8.8.8.8' })
		]);
		return s;
	}

	it('sums requests by status and lists the top addresses and networks', () => {
		const { query } = seeded();
		const result = query();
		expect(result.total).toBe(8);
		expect(result.statuses).toEqual([
			{ status: '2xx', count: 2 },
			{ status: '3xx', count: 1 },
			{ status: '4xx', count: 2 },
			{ status: '5xx', count: 1 },
			{ status: 'proxied', count: 1 },
			{ status: 'refused', count: 1 }
		]);
		expect(result.topClients[0]).toEqual({ client: '8.8.8.8', network: 'GOOGLE', count: 4 });
		expect(result.topNetworks).toEqual([
			{ asn: 15169, network: 'GOOGLE', count: 5 },
			{ asn: 64500, network: 'EXAMPLE-HOSTING', count: 3 }
		]);
		expect(result.entries).toHaveLength(8);
		expect(result.entries.find((e) => e.kind === 'tcp' && e.outcome === 'proxied')).toMatchObject({
			bytes: 30,
			nodeName: 'edge-1',
			status: null
		});
		expect(result.settings).toEqual({ retentionDays: 14, anonymised: false, networks: true });
	});

	it('filters by range, status, address, network and path', () => {
		const { query } = seeded();
		expect(query({ range: '1h' }).total).toBe(7);
		expect(
			query({ status: '4xx' })
				.entries.map((e) => e.path)
				.sort()
		).toEqual(['/.env', '/wp-admin/']);
		expect(query({ status: 'tcp' }).total).toBe(2);
		expect(query({ client: '203.0.113.9' }).total).toBe(3);
		expect(query({ asn: '15169' }).total).toBe(5);
		expect(query({ path: 'env' }).entries.map((e) => e.path)).toEqual(['/.env']);
		// LIKE's wildcards are taken literally
		expect(query({ path: '%_' }).entries.map((e) => e.path)).toEqual(['/100%_off']);
		expect(query({ path: '_' }).total).toBe(1);
	});

	it('is for owners and admins of the service’s organization only', () => {
		const { ctx, svc, env, query } = seeded();
		expect(() => query({ range: 'forever' })).toThrow();
		const other = seedCtx(ctx.db);
		expect(() =>
			traffic.serviceTraffic(other, svc.id, { environmentId: env.id }, { networks: false })
		).toThrow('Service not found');
		ctx.db.update(member).set({ role: 'member' }).where(eq(member.userId, ctx.userId)).run();
		expect(() => query()).toThrow(
			'Only organization owners and admins can see who reached a service'
		);
	});
});

describe('trusted proxies', () => {
	it('reach the ingress only when set, so other installs’ desired states stay the same', () => {
		const ctx = seedCtx();
		const dataDir = mkdtempSync(path.join(tmpdir(), 'tramline-traffic-'));
		const { node: local } = ensureLocalNode(ctx.db, dataDir);
		const ingress = (settings: PlatformSettings) =>
			buildDesiredState(ctx.db, testSecrets, settings, local.id).ingress;
		expect(ingress({ ...testSettings, dataDir })).not.toHaveProperty('trustedProxies');
		expect(
			ingress({ ...testSettings, dataDir, traffic: { ...DEFAULT_TRAFFIC, trustedProxies: [] } })
		).not.toHaveProperty('trustedProxies');
		expect(
			ingress({
				...testSettings,
				dataDir,
				traffic: { ...DEFAULT_TRAFFIC, trustedProxies: ['10.0.0.0/8'] }
			}).trustedProxies
		).toEqual(['10.0.0.0/8']);
	});
});
