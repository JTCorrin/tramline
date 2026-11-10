import type { AlertKind } from '@tramline/contracts';
import { and, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { accessLog, alert, environment, service } from '../db/schema';

/**
 * Alerts from access logs, checked with the others every minute. Each holds
 * while its condition has been seen in the last ten minutes:
 *
 * - traffic_errors: one address got many 401, 403 or 404 answers, like a
 *   password guesser or a crawler walking URLs.
 * - traffic_scanner: requests for paths only scanners ask for (`/.env`,
 *   `/.git/config`, `/wp-admin`…), when one was answered with a 2xx (the
 *   file may really be there) or there were many of them. A few probes a day
 *   are normal for anything on the internet, and alerting on those would
 *   only teach people to ignore the alert.
 * - traffic_new_network: a connection reached a service's database through
 *   its TCP proxy from a network that hadn't connected before. Only for
 *   services that already have a day of history, so turning access logs on
 *   doesn't page anyone for every network at once.
 */

export const TRAFFIC_WINDOW_MS = 10 * 60_000;
/** 401/403/404 answers to one address within the window. */
export const ERROR_BURST = 50;
/** Scanner-path requests within the window, when none was answered. */
export const SCANNER_BURST = 20;

/** Paths that only scanners ask for, matched at the start of the path, ignoring case. */
export const SCANNER_PATHS = [
	'/.env',
	'/.git/',
	'/.svn/',
	'/.hg/',
	'/.aws/',
	'/.ssh/',
	'/.ds_store',
	'/.htpasswd',
	'/wp-admin',
	'/wp-login.php',
	'/wp-config',
	'/xmlrpc.php',
	'/phpmyadmin',
	'/pma/',
	'/vendor/phpunit',
	'/cgi-bin/',
	'/server-status',
	'/actuator',
	'/boaform',
	'/hnap1',
	'/config.json',
	'/.vscode/',
	'/backup.sql',
	'/dump.sql'
];

export interface TrafficCondition {
	kind: AlertKind;
	serviceId: string;
	environmentId: string;
	value: number;
	message: string;
}

const escape = (prefix: string) => prefix.replace(/[\\%_]/g, (c) => `\\${c}`);

/** `path` starts with one of the scanner paths. */
export const scannerPath = () =>
	sql.join(
		SCANNER_PATHS.map((p) => sql`lower(${accessLog.path}) like ${`${escape(p)}%`} escape '\\'`),
		sql` or `
	);

const named = (client: string, network: string | null) =>
	network ? `${client} (${network})` : client;

function errorBursts(db: DbOrTx, since: Date): TrafficCondition[] {
	const rows = db
		.select({
			serviceId: accessLog.serviceId,
			environmentId: accessLog.environmentId,
			service: service.name,
			environment: environment.name,
			client: accessLog.client,
			network: sql<string | null>`max(${accessLog.network})`,
			count: sql<number>`sum(${accessLog.weight})`
		})
		.from(accessLog)
		.innerJoin(service, eq(service.id, accessLog.serviceId))
		.innerJoin(environment, eq(environment.id, accessLog.environmentId))
		.where(
			and(
				gte(accessLog.at, since),
				eq(accessLog.kind, 'http'),
				inArray(accessLog.status, [401, 403, 404])
			)
		)
		.groupBy(accessLog.serviceId, accessLog.environmentId, accessLog.client)
		.having(sql`sum(${accessLog.weight}) >= ${ERROR_BURST}`)
		.orderBy(sql`sum(${accessLog.weight}) desc`)
		.all();
	return [...Map.groupBy(rows, (r) => `${r.serviceId}:${r.environmentId}`).values()].map(
		(group) => {
			const top = group[0]!;
			const others = group.length > 1 ? ` (and ${group.length - 1} more addresses)` : '';
			return {
				kind: 'traffic_errors' as const,
				serviceId: top.serviceId,
				environmentId: top.environmentId,
				value: 1,
				message: `${top.service} in ${top.environment}: ${named(top.client, top.network)} got ${top.count} 401, 403 or 404 answers in 10 minutes${others}`
			};
		}
	);
}

function scanners(db: DbOrTx, since: Date): TrafficCondition[] {
	const rows = db
		.select({
			serviceId: accessLog.serviceId,
			environmentId: accessLog.environmentId,
			service: service.name,
			environment: environment.name,
			count: sql<number>`count(*)`,
			answered: sql<
				string | null
			>`max(case when ${accessLog.status} between 200 and 299 then ${accessLog.path} end)`,
			client: sql<string>`max(${accessLog.client})`,
			network: sql<string | null>`max(${accessLog.network})`
		})
		.from(accessLog)
		.innerJoin(service, eq(service.id, accessLog.serviceId))
		.innerJoin(environment, eq(environment.id, accessLog.environmentId))
		.where(and(gte(accessLog.at, since), eq(accessLog.kind, 'http'), scannerPath()))
		.groupBy(accessLog.serviceId, accessLog.environmentId)
		.all();
	return rows
		.filter((r) => r.answered || r.count >= SCANNER_BURST)
		.map((r) => ({
			kind: 'traffic_scanner' as const,
			serviceId: r.serviceId,
			environmentId: r.environmentId,
			value: 1,
			message: r.answered
				? `${r.service} in ${r.environment} answered a scanner's request for ${r.answered.split('?')[0]} with success: check it isn't serving files it shouldn't`
				: `${r.service} in ${r.environment} is being scanned: ${r.count} requests for paths like /.env or /wp-admin in 10 minutes, from ${named(r.client, r.network)} among others`
		}));
}

/** Who a network is, for comparing: its AS number, or the address's /24 when it has none. */
const networkKey = sql<string>`coalesce('AS' || ${accessLog.asn}, rtrim(${accessLog.client}, '0123456789'))`;

function newNetworks(db: DbOrTx, since: Date, now: number): TrafficCondition[] {
	const recent = db
		.select({
			serviceId: accessLog.serviceId,
			environmentId: accessLog.environmentId,
			service: service.name,
			environment: environment.name,
			key: networkKey,
			client: sql<string>`max(${accessLog.client})`,
			network: sql<string | null>`max(${accessLog.network})`
		})
		.from(accessLog)
		.innerJoin(service, eq(service.id, accessLog.serviceId))
		.innerJoin(environment, eq(environment.id, accessLog.environmentId))
		.where(
			and(gte(accessLog.at, since), eq(accessLog.kind, 'tcp'), eq(accessLog.outcome, 'proxied'))
		)
		.groupBy(accessLog.serviceId, accessLog.environmentId, networkKey)
		.all();
	const found = new Map<string, TrafficCondition>();
	for (const r of recent) {
		const key = `${r.serviceId}:${r.environmentId}`;
		if (found.has(key)) continue;
		const before = (extra: SQL) =>
			db
				.select({ one: sql<number>`1` })
				.from(accessLog)
				.where(
					and(
						eq(accessLog.serviceId, r.serviceId),
						eq(accessLog.environmentId, r.environmentId),
						eq(accessLog.kind, 'tcp'),
						eq(accessLog.outcome, 'proxied'),
						extra
					)
				)
				.limit(1)
				.get();
		// a day of history first, and this network nowhere in it
		if (!before(lt(accessLog.at, new Date(now - 86_400_000)))) continue;
		if (before(and(lt(accessLog.at, since), sql`${networkKey} = ${r.key}`)!)) continue;
		found.set(key, {
			kind: 'traffic_new_network',
			serviceId: r.serviceId,
			environmentId: r.environmentId,
			value: 1,
			message: `${r.service} in ${r.environment}: its database was reached through the TCP proxy from a new network, ${named(r.client, r.network ?? r.key)}`
		});
	}
	return [...found.values()];
}

export const TRAFFIC_ALERTS = ['traffic_errors', 'traffic_scanner', 'traffic_new_network'] as const;

/**
 * What the access logs show, plus a quiet reading for each open traffic
 * alert that nothing holds any more, so it resolves.
 */
export function trafficConditions(db: DbOrTx, now: number): TrafficCondition[] {
	const since = new Date(now - TRAFFIC_WINDOW_MS);
	const found = [...errorBursts(db, since), ...scanners(db, since), ...newNetworks(db, since, now)];
	const seen = new Set(found.map((c) => `${c.kind}:${c.serviceId}:${c.environmentId}`));
	for (const a of db
		.select({ kind: alert.kind, serviceId: alert.serviceId, environmentId: alert.environmentId })
		.from(alert)
		.where(and(inArray(alert.kind, [...TRAFFIC_ALERTS]), isNull(alert.resolvedAt)))
		.all()) {
		if (!a.serviceId || !a.environmentId || seen.has(`${a.kind}:${a.serviceId}:${a.environmentId}`))
			continue;
		found.push({
			kind: a.kind,
			serviceId: a.serviceId,
			environmentId: a.environmentId,
			value: 0,
			message: ''
		});
	}
	return found;
}
