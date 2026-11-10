import { describe, expect, it } from 'vitest';
import { accessLog, alert } from '../db/schema';
import * as environments from '../domain/environments';
import * as projects from '../domain/projects';
import * as services from '../domain/services';
import { evaluateAlerts } from '../metrics/alerts';
import { seedCtx } from '../testing';
import {
	ERROR_BURST,
	SCANNER_BURST,
	SCANNER_PATHS,
	TRAFFIC_WINDOW_MS,
	trafficConditions
} from './alerts';

const NOW = Date.UTC(2027, 0, 15, 8, 30);
const MIN = 60_000;
const DAY = 86_400_000;

function setup() {
	const ctx = seedCtx();
	const project = projects.create(ctx, { name: 'Shop' });
	const env = environments.list(ctx, project.id)[0]!;
	const svc = services.create(ctx, {
		projectId: project.id,
		kind: 'image',
		source: { type: 'image', image: 'nginx' }
	});
	type Row = Partial<typeof accessLog.$inferInsert> & { ago?: number };
	const log = (rows: Row[]) =>
		ctx.db
			.insert(accessLog)
			.values(
				rows.map(({ ago = MIN, ...row }) => ({
					at: new Date(NOW - ago),
					serviceId: svc.id,
					environmentId: env.id,
					kind: 'http' as const,
					method: 'GET',
					path: '/',
					status: 200,
					durationMs: 1,
					bytes: 1,
					client: '203.0.113.9',
					...row
				}))
			)
			.run();
	const kinds = (now = NOW) =>
		trafficConditions(ctx.db, now)
			.filter((c) => c.value === 1)
			.map((c) => c.kind);
	return { ctx, env, svc, log, kinds };
}

const times = (n: number, row: Record<string, unknown>) => Array.from({ length: n }, () => row);

describe('traffic alerts', () => {
	it('open on a burst of 401, 403 and 404 answers to one address', () => {
		const { log, kinds } = setup();
		log(times(ERROR_BURST - 1, { status: 401, network: 'EXAMPLE-HOSTING' }));
		// spread over other addresses, or older than the window, it isn't a burst
		log(times(ERROR_BURST, { status: 404, client: '198.51.100.1', ago: TRAFFIC_WINDOW_MS + MIN }));
		log([{ status: 500 }]);
		expect(kinds()).toEqual([]);
		log([{ status: 403 }]);
		expect(kinds()).toEqual(['traffic_errors']);
	});

	it('name the address and its network', () => {
		const { log, ctx } = setup();
		log(times(ERROR_BURST, { status: 404, network: 'EXAMPLE-HOSTING' }));
		log(times(ERROR_BURST, { status: 404, client: '198.51.100.1' }));
		const [condition] = trafficConditions(ctx.db, NOW);
		expect(condition!.message).toMatch(
			/^nginx in production: (203\.0\.113\.9 \(EXAMPLE-HOSTING\)|198\.51\.100\.1) got 50 401, 403 or 404 answers in 10 minutes \(and 1 more addresses\)$/
		);
	});

	it('open when a scanner path is answered, or there are many of them', () => {
		const answered = setup();
		answered.log(times(5, { path: '/.env', status: 404 }));
		expect(answered.kinds()).toEqual([]);
		answered.log([{ path: '/.git/config?x=1', status: 200 }]);
		const found = trafficConditions(answered.ctx.db, NOW);
		expect(found.map((c) => c.kind)).toEqual(['traffic_scanner']);
		expect(found[0]!.message).toContain('/.git/config with success');

		const flood = setup();
		flood.log(times(SCANNER_BURST - 1, { path: '/WP-ADMIN/setup.php', status: 404 }));
		// ordinary paths that merely contain a scanner word don't count
		flood.log([
			{ path: '/blog/.env-explained', status: 404 },
			{ path: '/docs/wp-admin', status: 404 }
		]);
		expect(flood.kinds()).toEqual([]);
		flood.log([{ path: '/phpmyadmin/', status: 404 }]);
		expect(trafficConditions(flood.ctx.db, NOW)[0]!.message).toContain(
			`${SCANNER_BURST} requests for paths like /.env`
		);
		expect(SCANNER_PATHS.every((p) => p === p.toLowerCase())).toBe(true);
	});

	it('open when a database is reached from a new network, once it has history', () => {
		const { log, kinds } = setup();
		const tcp = { kind: 'tcp' as const, path: null, status: null, outcome: 'proxied' };
		// the first connections ever: no history to compare with
		log([{ ...tcp, asn: 64500, network: 'HOME-ISP' }]);
		expect(kinds()).toEqual([]);
		log([{ ...tcp, asn: 64500, network: 'HOME-ISP', ago: 2 * DAY }]);
		// the same network as before
		expect(kinds()).toEqual([]);
		// refused connections are someone knocking, not someone getting in
		log([{ ...tcp, outcome: 'refused', asn: 15169 }]);
		expect(kinds()).toEqual([]);
		log([{ ...tcp, asn: 15169, network: 'GOOGLE', client: '34.1.2.3' }]);
		expect(kinds()).toEqual(['traffic_new_network']);
	});

	it('compares addresses without a network by their /24', () => {
		const { log, kinds } = setup();
		const tcp = { kind: 'tcp' as const, path: null, status: null, outcome: 'proxied' };
		log([{ ...tcp, client: '192.0.2.10', ago: 2 * DAY }]);
		log([{ ...tcp, client: '192.0.2.77' }]);
		expect(kinds()).toEqual([]);
		log([{ ...tcp, client: '192.0.3.1' }]);
		expect(kinds()).toEqual(['traffic_new_network']);
	});

	it('resolve once the window is quiet', () => {
		const { ctx, log } = setup();
		log(times(ERROR_BURST, { status: 401 }));
		expect(evaluateAlerts(ctx.db, NOW).opened.map((a) => a.kind)).toContain('traffic_errors');
		expect(evaluateAlerts(ctx.db, NOW + MIN).opened).toEqual([]);
		const later = evaluateAlerts(ctx.db, NOW + TRAFFIC_WINDOW_MS + MIN);
		expect(later.resolved.map((a) => a.kind)).toContain('traffic_errors');
		expect(
			ctx.db
				.select()
				.from(alert)
				.all()
				.every((a) => a.resolvedAt)
		).toBe(true);
	});
});
