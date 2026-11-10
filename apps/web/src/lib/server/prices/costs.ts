import type { EnvironmentCosts, ProjectCosts, ServiceCost } from '@tramline/contracts';
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
	deployment,
	environment,
	node,
	nodePool,
	nodeSpend,
	priceOffer,
	service,
	serviceSpend
} from '../db/schema';
import { requireEnvironment, requireProject } from '../domain/access';
import type { Ctx } from '../domain/context';
import { nodesOf, replicaNode, reservedOn } from '../nodes/placement';

/** Prices are per hour; a month is taken as 730 of them. */
export const HOURS_PER_MONTH = 730;

/** Deployments that hold a place on a node. */
const LIVE = ['building', 'deploying', 'active', 'crashed'] as const;

const cents = (n: number) => Math.round(n * 100) / 100;

/** Spend is added up this often, for the time since the last time. */
export const SPEND_INTERVAL_MS = 5 * 60_000;
/** A longer gap (Tramline was stopped) is counted as this much at most. */
const MAX_GAP_MS = 2 * SPEND_INTERVAL_MS;
/** Daily spend is kept this long. */
export const SPEND_KEPT_DAYS = 400;

/** A UTC day, `2026-11-10`. */
const dayOf = (at: Date) => at.toISOString().slice(0, 10);
/** The first day of `at`'s month, UTC. */
const monthStart = (at: Date) => `${at.toISOString().slice(0, 7)}-01`;

export interface NodeCost {
	monthly: number | null;
	source: 'entered' | 'provider' | null;
}

/**
 * What each node costs a month: what someone entered for it, else its
 * provider's price for the size it was created as (from the price catalog,
 * or the pool's price when the catalog hasn't got it), else nothing.
 */
export function nodeCosts(db: DbOrTx): Map<string, NodeCost> {
	const prices = new Map(
		db
			.select({
				accountId: priceOffer.accountId,
				region: priceOffer.region,
				offerId: priceOffer.offerId,
				hourly: priceOffer.hourly
			})
			.from(priceOffer)
			.all()
			.map((o) => [`${o.accountId}\n${o.region}\n${o.offerId}`, o.hourly])
	);
	const pools = new Map(
		db
			.select({ id: nodePool.id, hourly: nodePool.hourly })
			.from(nodePool)
			.all()
			.map((p) => [p.id, p.hourly])
	);
	const costs = new Map<string, NodeCost>();
	for (const n of db
		.select({
			id: node.id,
			accountId: node.adapterAccountId,
			region: node.region,
			offer: node.offer,
			poolId: node.poolId,
			monthlyCost: node.monthlyCost
		})
		.from(node)
		.all()) {
		if (n.monthlyCost !== null) {
			costs.set(n.id, { monthly: n.monthlyCost, source: 'entered' });
			continue;
		}
		const hourly =
			(n.accountId && n.region && n.offer
				? prices.get(`${n.accountId}\n${n.region}\n${n.offer}`)
				: null) ??
			(n.poolId ? pools.get(n.poolId) : null) ??
			null;
		costs.set(
			n.id,
			hourly === null
				? { monthly: null, source: null }
				: { monthly: cents(hourly * HOURS_PER_MONTH), source: 'provider' }
		);
	}
	return costs;
}

/**
 * A service's cost is its part of each node it runs on: the larger of the
 * CPU, memory and GPUs it reserves there, over what the node has. What
 * nothing reserves isn't charged to anyone, so a service with no requests
 * or limits is free on a node it shares.
 */
function costsOf(
	db: DbOrTx,
	environmentId: string,
	prices: Map<string, NodeCost>,
	now = new Date()
) {
	const spent = new Map(
		db
			.select({
				serviceId: serviceSpend.serviceId,
				amount: sql<number>`sum(${serviceSpend.amount})`
			})
			.from(serviceSpend)
			.where(
				and(eq(serviceSpend.environmentId, environmentId), gte(serviceSpend.day, monthStart(now)))
			)
			.groupBy(serviceSpend.serviceId)
			.all()
			.map((r) => [r.serviceId, r.amount])
	);
	const nodes = new Map(
		db
			.select({ id: node.id, name: node.name, info: node.info })
			.from(node)
			.all()
			.map((n) => [n.id, n])
	);
	const live = db
		.select({
			serviceId: deployment.serviceId,
			name: service.name,
			status: deployment.status,
			nodeId: deployment.nodeId,
			replicaNodes: deployment.replicaNodes,
			replicaGpus: deployment.replicaGpus,
			config: deployment.config
		})
		.from(deployment)
		.innerJoin(service, eq(deployment.serviceId, service.id))
		.where(and(eq(deployment.environmentId, environmentId), inArray(deployment.status, [...LIVE])))
		.orderBy(desc(deployment.createdAt))
		.all();
	// while a deploy rolls over two are live; the one running now is what's paid for
	const current = new Map<string, (typeof live)[number]>();
	for (const d of live) {
		const seen = current.get(d.serviceId);
		if (!seen || (seen.status !== 'active' && d.status === 'active')) current.set(d.serviceId, d);
	}
	const services: ServiceCost[] = [...current.values()]
		.map((d) => {
			const parts = nodesOf(d).map((nodeId) => {
				const n = nodes.get(nodeId);
				const reserved = reservedOn(d, nodeId);
				const gpus = (d.replicaGpus ?? []).reduce(
					(sum, held, replica) => sum + (replicaNode(d, replica) === nodeId ? held.length : 0),
					0
				);
				const of = (used: number, total: number | undefined) => (total ? used / total : 0);
				const share = Math.min(
					1,
					Math.max(
						of(reserved.cpus, n?.info?.cpus),
						of(reserved.memoryMb, n?.info?.memoryMb),
						of(gpus, n?.info?.gpus?.length)
					)
				);
				const price = prices.get(nodeId)?.monthly ?? null;
				return {
					nodeId,
					name: n?.name ?? nodeId,
					share: Math.round(share * 1000) / 1000,
					monthly: price === null ? null : cents(price * share)
				};
			});
			const unpriced = parts.some((p) => p.monthly === null && p.share > 0);
			return {
				serviceId: d.serviceId,
				name: d.name,
				monthly: unpriced ? null : cents(parts.reduce((sum, p) => sum + (p.monthly ?? 0), 0)),
				unreserved: parts.every((p) => p.share === 0),
				spent: cents(spent.get(d.serviceId) ?? 0),
				nodes: parts
			};
		})
		.sort((a, b) => (b.monthly ?? -1) - (a.monthly ?? -1) || a.name.localeCompare(b.name));
	return {
		monthly: cents(services.reduce((sum, s) => sum + (s.monthly ?? 0), 0)),
		complete: services.every((s) => s.monthly !== null),
		spent: cents([...spent.values()].reduce((sum, a) => sum + a, 0)),
		services
	};
}

/** What an environment's running services cost a month. Any member of the organization can see it. */
export function environmentCosts(
	ctx: Ctx,
	environmentId: string,
	now = new Date()
): EnvironmentCosts {
	requireEnvironment(ctx, environmentId);
	return { environmentId, ...costsOf(ctx.db, environmentId, nodeCosts(ctx.db), now) };
}

/** What a project costs a month, environment by environment. */
export function projectCosts(ctx: Ctx, projectId: string, now = new Date()): ProjectCosts {
	requireProject(ctx, projectId);
	const prices = nodeCosts(ctx.db);
	const environments = ctx.db
		.select({ id: environment.id, name: environment.name })
		.from(environment)
		.where(eq(environment.projectId, projectId))
		.orderBy(asc(environment.createdAt))
		.all()
		.map((e) => {
			const { monthly, complete, spent } = costsOf(ctx.db, e.id, prices, now);
			return { environmentId: e.id, name: e.name, monthly, complete, spent };
		});
	return {
		projectId,
		monthly: cents(environments.reduce((sum, e) => sum + e.monthly, 0)),
		complete: environments.every((e) => e.complete),
		spent: cents(environments.reduce((sum, e) => sum + e.spent, 0)),
		environments
	};
}

/** What each node has cost so far this month, by node ID. */
export function nodeSpentThisMonth(db: DbOrTx, now = new Date()) {
	return new Map(
		db
			.select({ nodeId: nodeSpend.nodeId, amount: sql<number>`sum(${nodeSpend.amount})` })
			.from(nodeSpend)
			.where(gte(nodeSpend.day, monthStart(now)))
			.groupBy(nodeSpend.nodeId)
			.all()
			.map((r) => [r.nodeId, cents(r.amount)])
	);
}

/**
 * Adds what nodes and services cost between `from` and `to` to the day's
 * spend: each at its monthly cost now, for that many hours of a 730-hour
 * month. A gap longer than a couple of runs, while Tramline was stopped,
 * counts as a couple of runs, since nobody saw what ran then.
 */
export function accrueSpend(db: DbOrTx, from: Date, to: Date) {
	const ms = Math.min(to.getTime() - from.getTime(), MAX_GAP_MS);
	if (ms <= 0) return;
	const part = ms / 3600_000 / HOURS_PER_MONTH;
	// on the day it began, so a run ending at midnight counts for the day before
	const day = dayOf(new Date(to.getTime() - ms));
	const prices = nodeCosts(db);
	const names = new Map(
		db
			.select({ id: node.id, name: node.name })
			.from(node)
			.all()
			.map((n) => [n.id, n.name])
	);
	const environments = db.select({ id: environment.id }).from(environment).all();
	db.transaction((tx) => {
		for (const [nodeId, cost] of prices) {
			if (!cost.monthly) continue;
			const amount = cost.monthly * part;
			tx.insert(nodeSpend)
				.values({ day, nodeId, nodeName: names.get(nodeId) ?? nodeId, amount })
				.onConflictDoUpdate({
					target: [nodeSpend.day, nodeSpend.nodeId],
					set: {
						amount: sql`${nodeSpend.amount} + ${amount}`,
						nodeName: names.get(nodeId) ?? nodeId
					}
				})
				.run();
		}
		for (const e of environments) {
			for (const s of costsOf(tx, e.id, prices, to).services) {
				if (!s.monthly) continue;
				const amount = s.monthly * part;
				tx.insert(serviceSpend)
					.values({ day, serviceId: s.serviceId, environmentId: e.id, amount })
					.onConflictDoUpdate({
						target: [serviceSpend.day, serviceSpend.serviceId, serviceSpend.environmentId],
						set: { amount: sql`${serviceSpend.amount} + ${amount}` }
					})
					.run();
			}
		}
		const cutoff = dayOf(new Date(to.getTime() - SPEND_KEPT_DAYS * 24 * 3600_000));
		tx.delete(nodeSpend).where(lt(nodeSpend.day, cutoff)).run();
		tx.delete(serviceSpend).where(lt(serviceSpend.day, cutoff)).run();
	});
}
