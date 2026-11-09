import type {
	AccessEntry,
	SshFailures,
	Traffic,
	TrafficEntry,
	TrafficQuery
} from '@tramline/contracts';
import { and, desc, eq, gte, inArray, isNotNull, lt, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { accessLog, customDomain, node, serviceInstance, sshFailure } from '../db/schema';
import type { TrafficSettings } from '../settings';
import { anonymize, type Network } from './asn';

/**
 * Access logs: what came in through the ingress and the TCP proxies, kept
 * per service so its owners can see who is knocking.
 */

/** Successful requests a service has in a minute before they're sampled. */
export const SAMPLE_AFTER = 300;
/** Past that, one success in this many is kept, standing for all of them. */
export const SAMPLE_EVERY = 10;
const INSERT_CHUNK = 500;

type Target = { serviceId: string; environmentId: string };
type ServiceEntry = Exclude<AccessEntry, { kind: 'ssh' }>;
type SshEntry = Extract<AccessEntry, { kind: 'ssh' }>;

/**
 * Which service each entry is for: HTTP by host (the generated domain, or a
 * verified custom one), TCP by its public port. Entries for addresses no
 * service owns, e.g. a scanner trying the node's IP, are dropped.
 */
function targets(db: DbOrTx, entries: ServiceEntry[]) {
	const hosts = [...new Set(entries.flatMap((e) => (e.kind === 'http' ? [e.host] : [])))];
	const ports = [...new Set(entries.flatMap((e) => (e.kind === 'tcp' ? [e.port] : [])))];
	const byHost = new Map<string, Target>();
	const byPort = new Map<number, Target>();
	if (hosts.length) {
		for (const row of db
			.select({
				domain: serviceInstance.domain,
				serviceId: serviceInstance.serviceId,
				environmentId: serviceInstance.environmentId
			})
			.from(serviceInstance)
			.where(inArray(serviceInstance.domain, hosts))
			.all()) {
			byHost.set(row.domain!, row);
		}
		for (const row of db
			.select({
				hostname: customDomain.hostname,
				serviceId: customDomain.serviceId,
				environmentId: customDomain.environmentId
			})
			.from(customDomain)
			.where(and(inArray(customDomain.hostname, hosts), eq(customDomain.status, 'verified')))
			.all()) {
			byHost.set(row.hostname, row);
		}
	}
	if (ports.length) {
		for (const row of db
			.select({
				port: serviceInstance.tcpPort,
				serviceId: serviceInstance.serviceId,
				environmentId: serviceInstance.environmentId
			})
			.from(serviceInstance)
			.where(and(isNotNull(serviceInstance.tcpPort), inArray(serviceInstance.tcpPort, ports)))
			.all()) {
			byPort.set(row.port!, row);
		}
	}
	return (entry: ServiceEntry) =>
		entry.kind === 'http' ? byHost.get(entry.host) : byPort.get(entry.port);
}

/**
 * Counts successes per service and minute, so a busy service's are sampled
 * once it is past SAMPLE_AFTER in a minute. Errors and TCP connections are
 * always kept: they're what the Traffic tab is for.
 */
export class Sampler {
	#minute = 0;
	#counts = new Map<string, number>();

	/** The entry's weight, or 0 to drop it. */
	weigh(target: Target, entry: AccessEntry) {
		if (entry.kind !== 'http' || entry.status >= 400) return 1;
		const minute = Math.floor(Date.parse(entry.ts) / 60_000);
		if (minute > this.#minute) {
			this.#minute = minute;
			this.#counts.clear();
		}
		const key = `${target.serviceId}:${target.environmentId}:${minute}`;
		const seen = (this.#counts.get(key) ?? 0) + 1;
		this.#counts.set(key, seen);
		if (seen <= SAMPLE_AFTER) return 1;
		return (seen - SAMPLE_AFTER) % SAMPLE_EVERY === 0 ? SAMPLE_EVERY : 0;
	}
}

const defaultSampler = new Sampler();

export function recordAccess(
	db: DbOrTx,
	nodeId: string,
	entries: AccessEntry[],
	options: {
		settings: Pick<TrafficSettings, 'retentionDays' | 'anonymize'>;
		lookup: (address: string) => Network | null;
		sampler?: Sampler;
		now?: number;
	}
) {
	const { settings, lookup, sampler = defaultSampler, now = Date.now() } = options;
	if (!settings.retentionDays || !entries.length) return 0;
	const oldest = now - settings.retentionDays * 86_400_000;
	const fresh = (ts: string) => {
		const at = Date.parse(ts);
		// an agent's clock far in the future would keep a row past its retention
		return at >= oldest && at <= now + 3_600_000;
	};
	const ssh = entries.filter((e): e is SshEntry => e.kind === 'ssh' && fresh(e.ts));
	const traffic = entries.filter((e): e is ServiceEntry => e.kind !== 'ssh');
	recordSshFailures(db, nodeId, ssh, settings, lookup);
	if (!traffic.length) return 0;
	const targetOf = targets(db, traffic);
	const rows: (typeof accessLog.$inferInsert)[] = [];
	for (const entry of traffic) {
		const target = targetOf(entry);
		if (!target || !fresh(entry.ts)) continue;
		const at = Date.parse(entry.ts);
		const weight = sampler.weigh(target, entry);
		if (!weight) continue;
		const network = lookup(entry.client);
		rows.push({
			at: new Date(at),
			serviceId: target.serviceId,
			environmentId: target.environmentId,
			nodeId,
			kind: entry.kind,
			durationMs: entry.durationMs,
			client: settings.anonymize ? anonymize(entry.client) : entry.client,
			asn: network?.asn ?? null,
			network: network?.name ?? null,
			weight,
			...(entry.kind === 'http'
				? {
						host: entry.host,
						method: entry.method,
						path: entry.path,
						status: entry.status,
						bytes: entry.bytes,
						userAgent: entry.userAgent
					}
				: { outcome: entry.outcome, bytes: entry.bytesIn + entry.bytesOut })
		});
	}
	for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
		db.insert(accessLog)
			.values(rows.slice(i, i + INSERT_CHUNK))
			.run();
	}
	return rows.length;
}

/** Failed SSH logins, counted per node, address and minute. */
function recordSshFailures(
	db: DbOrTx,
	nodeId: string,
	entries: SshEntry[],
	settings: Pick<TrafficSettings, 'anonymize'>,
	lookup: (address: string) => Network | null
) {
	for (const [key, group] of Map.groupBy(
		entries,
		(e) => `${Math.floor(Date.parse(e.ts) / 60_000)}|${e.client}`
	)) {
		const [minute, address] = key.split('|') as [string, string];
		const network = lookup(address);
		const client = settings.anonymize ? anonymize(address) : address;
		const user = group.at(-1)!.user;
		db.insert(sshFailure)
			.values({
				nodeId,
				bucket: new Date(Number(minute) * 60_000),
				client,
				count: group.length,
				user,
				asn: network?.asn ?? null,
				network: network?.name ?? null
			})
			.onConflictDoUpdate({
				target: [sshFailure.nodeId, sshFailure.bucket, sshFailure.client],
				set: { count: sql`${sshFailure.count} + ${group.length}`, user }
			})
			.run();
	}
}

/** A node's failed SSH logins over the last day, busiest addresses first. */
export function sshFailures(db: DbOrTx, nodeId: string, now = Date.now()): SshFailures {
	const where = and(
		eq(sshFailure.nodeId, nodeId),
		gte(sshFailure.bucket, new Date(now - 86_400_000))
	);
	const totals = db
		.select({
			total: sql<number | null>`sum(${sshFailure.count})`,
			addresses: sql<number>`count(distinct ${sshFailure.client})`
		})
		.from(sshFailure)
		.where(where)
		.get();
	const top = db
		.select({
			client: sshFailure.client,
			network: sql<string | null>`max(${sshFailure.network})`,
			count: sql<number>`sum(${sshFailure.count})`,
			// the user name from the client's latest minute
			user: sql<
				string | null
			>`(select s2.user from ssh_failure s2 where s2.node_id = ${sshFailure.nodeId}
				and s2.client = ${sshFailure.client} order by s2.bucket desc limit 1)`,
			lastAt: sql<number>`max(${sshFailure.bucket})`
		})
		.from(sshFailure)
		.where(where)
		.groupBy(sshFailure.client)
		.orderBy(desc(sql`sum(${sshFailure.count})`))
		.limit(10)
		.all();
	return {
		total: totals?.total ?? 0,
		addresses: totals?.addresses ?? 0,
		top: top.map((t) => ({ ...t, lastAt: new Date(t.lastAt).toISOString() }))
	};
}

/** Drops entries past their retention, then the oldest beyond the install's row cap. */
export function pruneAccessLogs(
	db: DbOrTx,
	settings: Pick<TrafficSettings, 'retentionDays' | 'maxRows'>,
	now = Date.now()
) {
	const oldest = new Date(now - settings.retentionDays * 86_400_000);
	db.delete(accessLog).where(lt(accessLog.at, oldest)).run();
	db.delete(sshFailure).where(lt(sshFailure.bucket, oldest)).run();
	// ids only grow, so keeping those above the newest minus the cap keeps at most the cap,
	// without counting the table
	const newest = db
		.select({ id: sql<number | null>`max(${accessLog.id})` })
		.from(accessLog)
		.get()?.id;
	if (newest && newest > settings.maxRows) {
		db.delete(accessLog)
			.where(lt(accessLog.id, newest - settings.maxRows + 1))
			.run();
	}
}

const RANGES = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 } as const;

/** `2xx`…`5xx` for requests; a TCP connection's outcome. */
const statusLabel = sql<string>`case when ${accessLog.kind} = 'tcp' then ${accessLog.outcome} else (${accessLog.status} / 100) || 'xx' end`;
const weighted = sql<number>`sum(${accessLog.weight})`;

/** A service's traffic in an environment, with the newest entries. */
export function traffic(
	db: DbOrTx,
	serviceId: string,
	query: TrafficQuery,
	settings: Pick<TrafficSettings, 'retentionDays' | 'anonymize'> & { networks: boolean },
	now = Date.now()
): Traffic {
	const filters: SQL[] = [
		eq(accessLog.serviceId, serviceId),
		eq(accessLog.environmentId, query.environmentId),
		gte(accessLog.at, new Date(now - RANGES[query.range]))
	];
	if (query.status === 'tcp') filters.push(eq(accessLog.kind, 'tcp'));
	else if (query.status) {
		const floor = Number(query.status[0]) * 100;
		filters.push(gte(accessLog.status, floor), lt(accessLog.status, floor + 100));
	}
	if (query.client) filters.push(eq(accessLog.client, query.client));
	if (query.asn !== undefined) filters.push(eq(accessLog.asn, query.asn));
	if (query.path) {
		const escaped = query.path.replace(/[\\%_]/g, (c) => `\\${c}`);
		filters.push(sql`${accessLog.path} like ${`%${escaped}%`} escape '\\'`);
	}
	const where = and(...filters);

	const total = db.select({ total: weighted }).from(accessLog).where(where).get()?.total ?? 0;
	const statuses = db
		.select({ status: statusLabel, count: weighted })
		.from(accessLog)
		.where(where)
		.groupBy(statusLabel)
		.orderBy(statusLabel)
		.all()
		.map((s) => ({ status: s.status ?? 'unknown', count: s.count }));
	const topClients = db
		.select({
			client: accessLog.client,
			network: sql<string | null>`max(${accessLog.network})`,
			count: weighted
		})
		.from(accessLog)
		.where(where)
		.groupBy(accessLog.client)
		.orderBy(desc(weighted))
		.limit(10)
		.all();
	const topNetworks = db
		.select({
			asn: accessLog.asn,
			network: sql<string | null>`max(${accessLog.network})`,
			count: weighted
		})
		.from(accessLog)
		.where(where)
		.groupBy(accessLog.asn)
		.orderBy(desc(weighted))
		.limit(10)
		.all();
	const entries: TrafficEntry[] = db
		.select({ log: accessLog, nodeName: node.name })
		.from(accessLog)
		.leftJoin(node, eq(node.id, accessLog.nodeId))
		.where(where)
		.orderBy(desc(accessLog.at), desc(accessLog.id))
		.limit(200)
		.all()
		.map(({ log, nodeName }) => ({
			at: log.at.toISOString(),
			kind: log.kind,
			host: log.host,
			method: log.method,
			path: log.path,
			status: log.status,
			outcome: log.outcome,
			durationMs: log.durationMs,
			bytes: log.bytes,
			client: log.client,
			asn: log.asn,
			network: log.network,
			userAgent: log.userAgent,
			nodeName,
			weight: log.weight
		}));
	return {
		total,
		statuses,
		topClients,
		topNetworks,
		entries,
		settings: {
			retentionDays: settings.retentionDays,
			anonymised: settings.anonymize,
			networks: settings.networks
		}
	};
}
