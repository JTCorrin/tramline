import type { Alert, AlertKind } from '@tramline/contracts';
import { and, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
	alert,
	containerMetric,
	deployment,
	environment,
	node,
	nodeMetric,
	service
} from '../db/schema';
import { newId } from '../ids';
import { MINUTE, pruneMetrics, rollUp } from './store';

/**
 * Built-in alerts, checked every minute. Each opens when its condition holds
 * and resolves once it clears; usage alerts open at 90% and clear below 85%,
 * so a value hovering at the line doesn't flap.
 */

/** A node that hasn't reported for this long is offline. */
export const OFFLINE_AFTER_MS = 2 * 60_000;
/** Memory is averaged over this window, so a short spike doesn't page anyone. */
export const MEMORY_WINDOW_MS = 5 * 60_000;
export const OPEN_AT = 0.9;
export const CLEAR_BELOW = 0.85;

type AlertRow = typeof alert.$inferSelect;

interface Condition {
	kind: AlertKind;
	nodeId?: string;
	serviceId?: string;
	environmentId?: string;
	/** How full, from 0 to 1; offline nodes are 1. */
	value: number;
	message: string;
}

const subject = (a: {
	kind: string;
	nodeId?: string | null;
	serviceId?: string | null;
	environmentId?: string | null;
}) => `${a.kind}:${a.nodeId ?? ''}:${a.serviceId ?? ''}:${a.environmentId ?? ''}`;

const pct = (value: number) => `${Math.round(value * 100)}%`;
const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

function conditions(db: DbOrTx, now: number): Condition[] {
	const found: Condition[] = [];
	const names = new Map(
		db
			.select({ id: node.id, name: node.name })
			.from(node)
			.all()
			.map((n) => [n.id, n.name])
	);

	// nodes that reported before and have gone quiet; a node that never reported is still enrolling
	for (const n of db
		.select({ id: node.id, name: node.name, lastSeenAt: node.lastSeenAt })
		.from(node)
		.where(isNotNull(node.lastSeenAt))
		.all()) {
		const silent = now - n.lastSeenAt!.getTime();
		if (silent >= OFFLINE_AFTER_MS) {
			found.push({
				kind: 'node_offline',
				nodeId: n.id,
				value: 1,
				message: `${n.name} stopped reporting ${Math.round(silent / 60_000)} minutes ago`
			});
		}
	}

	const since = now - MEMORY_WINDOW_MS;
	const usage = db
		.select({
			nodeId: nodeMetric.nodeId,
			buckets: sql<number>`count(*)`,
			memory: sql<number>`sum(${nodeMetric.memoryUsedSum}) / sum(${nodeMetric.samples})`,
			memoryTotal: sql<number>`max(${nodeMetric.memoryTotal})`,
			// the latest minute's disk
			disk: sql<number | null>`(select n2.disk_used from node_metric n2 where n2.step = ${MINUTE}
				and n2.node_id = ${nodeMetric.nodeId} and n2.disk_used is not null order by n2.bucket desc limit 1)`,
			diskTotal: sql<
				number | null
			>`(select n2.disk_total from node_metric n2 where n2.step = ${MINUTE}
				and n2.node_id = ${nodeMetric.nodeId} and n2.disk_used is not null order by n2.bucket desc limit 1)`
		})
		.from(nodeMetric)
		.where(and(eq(nodeMetric.step, MINUTE), gte(nodeMetric.bucket, since)))
		.groupBy(nodeMetric.nodeId)
		.all();
	for (const u of usage) {
		const name = names.get(u.nodeId) ?? u.nodeId;
		if (u.disk !== null && u.diskTotal) {
			const value = u.disk / u.diskTotal;
			found.push({
				kind: 'node_disk',
				nodeId: u.nodeId,
				value,
				message: `Disk on ${name} is ${pct(value)} full (${gb(u.disk)} of ${gb(u.diskTotal)})`
			});
		}
		// a few minutes of data first, so a node that just started isn't judged on one sample
		if (u.buckets >= 3 && u.memoryTotal) {
			const value = u.memory / u.memoryTotal;
			found.push({
				kind: 'node_memory',
				nodeId: u.nodeId,
				value,
				message: `${name} is using ${pct(value)} of its memory (${gb(u.memory)} of ${gb(u.memoryTotal)})`
			});
		}
	}

	// replicas of live deployments with a memory limit, averaged over the window
	const m = containerMetric;
	const replicas = db
		.select({
			serviceId: m.serviceId,
			environmentId: m.environmentId,
			service: service.name,
			environment: environment.name,
			buckets: sql<number>`count(*)`,
			memory: sql<number>`sum(${m.memorySum}) / sum(${m.samples})`,
			limit: sql<number>`max(${m.memoryLimit})`
		})
		.from(m)
		.innerJoin(deployment, eq(deployment.id, m.deploymentId))
		.innerJoin(service, eq(service.id, m.serviceId))
		.innerJoin(environment, eq(environment.id, m.environmentId))
		.where(
			and(
				eq(m.step, MINUTE),
				gte(m.bucket, since),
				isNotNull(m.memoryLimit),
				inArray(deployment.status, ['active', 'crashed'])
			)
		)
		.groupBy(m.deploymentId, m.replica)
		.all();
	// a service is as full as its fullest replica
	const fullest = new Map<string, Condition>();
	for (const r of replicas) {
		if (r.buckets < 3 || !r.limit) continue;
		const value = r.memory / r.limit;
		const key = `${r.serviceId}:${r.environmentId}`;
		if ((fullest.get(key)?.value ?? -1) >= value) continue;
		fullest.set(key, {
			kind: 'service_memory',
			serviceId: r.serviceId,
			environmentId: r.environmentId,
			value,
			message: `${r.service} in ${r.environment} is using ${pct(value)} of its memory limit (${Math.round(r.memory)} of ${Math.round(r.limit)} MB)`
		});
	}
	found.push(...fullest.values());
	return found;
}

export const toAlert = (row: AlertRow): Alert => ({
	id: row.id,
	kind: row.kind,
	nodeId: row.nodeId,
	serviceId: row.serviceId,
	environmentId: row.environmentId,
	message: row.message,
	openedAt: row.openedAt.toISOString(),
	resolvedAt: row.resolvedAt?.toISOString() ?? null
});

/** Opens and resolves alerts; returns what changed, for notifications. */
export function evaluateAlerts(db: DbOrTx, now = Date.now()) {
	const open = new Map(
		db
			.select()
			.from(alert)
			.where(isNull(alert.resolvedAt))
			.all()
			.map((a) => [subject(a), a])
	);
	const opened: Alert[] = [];
	const resolved: Alert[] = [];
	const holding = new Set<string>();
	const observed = new Set<string>();
	const liveServices = new Set(
		db
			.select({ serviceId: deployment.serviceId, environmentId: deployment.environmentId })
			.from(deployment)
			.where(inArray(deployment.status, ['active', 'crashed']))
			.all()
			.map((d) => `${d.serviceId}:${d.environmentId}`)
	);
	for (const c of conditions(db, now)) {
		const key = subject(c);
		observed.add(key);
		const existing = open.get(key);
		if (existing) {
			if (c.value >= CLEAR_BELOW) holding.add(key);
			continue;
		}
		if (c.value < OPEN_AT) continue;
		const row = db
			.insert(alert)
			.values({
				id: newId('alert'),
				kind: c.kind,
				nodeId: c.nodeId ?? null,
				serviceId: c.serviceId ?? null,
				environmentId: c.environmentId ?? null,
				message: c.message,
				openedAt: new Date(now)
			})
			.returning()
			.get();
		holding.add(key);
		opened.push(toAlert(row));
	}
	// Missing telemetry is not evidence of recovery. Removed services can resolve.
	for (const [key, row] of open) {
		if (holding.has(key)) continue;
		if (
			!observed.has(key) &&
			row.kind !== 'node_offline' &&
			(row.nodeId || liveServices.has(`${row.serviceId}:${row.environmentId}`))
		)
			continue;
		const done = db
			.update(alert)
			.set({ resolvedAt: new Date(now) })
			.where(eq(alert.id, row.id))
			.returning()
			.get();
		resolved.push(toAlert(done));
	}
	return { opened, resolved };
}

/** Resolved alerts are kept for a month. */
export function pruneAlerts(db: DbOrTx, now = Date.now()) {
	db.delete(alert)
		.where(sql`${alert.resolvedAt} < ${now - 30 * 86_400_000}`)
		.run();
}

/**
 * Posts each change to the alert webhook. Slack reads `text` and Discord
 * `content`; anything else can use `alert`. Failures are logged, never thrown:
 * a webhook that's down mustn't stop the next check.
 */
export async function notifyAlerts(
	url: string | undefined,
	changes: { opened: Alert[]; resolved: Alert[] },
	fetcher: typeof fetch = fetch
) {
	if (!url) return;
	const posts = [
		...changes.opened.map((a) => ({
			status: 'opened' as const,
			alert: a,
			text: `🔴 ${a.message}`
		})),
		...changes.resolved.map((a) => ({
			status: 'resolved' as const,
			alert: a,
			text: `✅ Resolved: ${a.message}`
		}))
	];
	for (const post of posts) {
		try {
			const res = await fetcher(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...post, content: post.text }),
				redirect: 'error',
				signal: AbortSignal.timeout(10_000)
			});
			if (!res.ok) console.error(`[alerts] the webhook answered ${res.status}`);
		} catch (error) {
			console.error('[alerts] the webhook failed:', error instanceof Error ? error.message : error);
		}
	}
}

/** The minute job: roll metrics up, prune them, then check and announce alerts. */
export async function runMetricsJobs(db: DbOrTx, webhookUrl: string | undefined, now = Date.now()) {
	rollUp(db, now);
	pruneMetrics(db, now);
	pruneAlerts(db, now);
	await notifyAlerts(webhookUrl, evaluateAlerts(db, now));
}
