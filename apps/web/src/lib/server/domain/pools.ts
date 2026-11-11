import type { CreateNodePool, NodePool, UpdateNodePool } from '@tramline/contracts';
import { CreateNodePool as CreateSchema } from '@tramline/contracts';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { AppError, notFound } from '../api/errors';
import type { Secrets } from '../crypto';
import type { Db } from '../db/client';
import {
	adapterAccount,
	deployment,
	environment,
	joinToken,
	node,
	nodePool,
	project,
	publicTunnel,
	volume
} from '../db/schema';
import { newId } from '../ids';
import { HOURS_PER_MONTH } from '../prices/costs';
import { notifyNodes } from '../nodes/bus';
import { gpuRequest, offerFits } from '../nodes/gpus';
import { onNode, replicaRequest } from '../nodes/placement';
import { isOnline } from '../nodes/registry';
import { volumeFor } from '../nodes/volumes';
import type { PlatformSettings } from '../settings';
import { requireInstallAdmin } from './admins';
import { call, connect, destroyPending, provisionMachine, requireAccount } from './adapters';
import type { Ctx } from './context';
import * as environments from './environments';
import { drainNode, removeNode } from './nodes';

/**
 * Node pools add machines when work is waiting and remove them when they're
 * idle. Every change goes through the same paths as a person's would: a
 * machine is provisioned like "Add node", and removed like "Remove", so an
 * idle node holding data is never destroyed.
 */

type PoolRow = typeof nodePool.$inferSelect;

/** Hours in a month, for estimates. */
export { HOURS_PER_MONTH };
/** Queued this long, a deployment has been through the scheduler and found no room. */
export const WAITING_MS = 15_000;
/** A pool machine that just joined gets this long to take the waiting work before another is added. */
const SETTLING_MS = 2 * 60_000;
/** After a provider error, wait this long before asking it again. */
export const ERROR_BACKOFF_MS = 5 * 60_000;
/** Some of a machine's memory goes to the system, Docker and the agent. */
const USABLE_MEMORY = 0.9;

/** Deployments that hold a place on a node. */
const LIVE = ['building', 'deploying', 'active', 'crashed'] as const;

const monthly = (row: PoolRow, machines: number) =>
	row.hourly === null ? null : Math.round(row.hourly * HOURS_PER_MONTH * machines * 100) / 100;

function members(db: Db, poolId: string) {
	return db.select().from(node).where(eq(node.poolId, poolId)).orderBy(asc(node.createdAt)).all();
}

/** Machines the pool asked for that haven't enrolled (including ones that never will). */
function pending(db: Db, poolId: string) {
	return db
		.select()
		.from(joinToken)
		.where(and(eq(joinToken.poolId, poolId), isNull(joinToken.usedAt)))
		.all();
}

function toDto(db: Db, row: PoolRow): NodePool {
	const account = db
		.select()
		.from(adapterAccount)
		.where(eq(adapterAccount.id, row.adapterAccountId))
		.get()!;
	const env = row.environmentId
		? db
				.select({ id: environment.id, name: environment.name, project: project.name })
				.from(environment)
				.innerJoin(project, eq(project.id, environment.projectId))
				.where(eq(environment.id, row.environmentId))
				.get()
		: null;
	const nodes = members(db, row.id);
	const waiting = pending(db, row.id).length;
	const now = monthly(row, nodes.length + waiting);
	return {
		id: row.id,
		name: row.name,
		account: { id: account.id, name: account.name, adapter: account.adapter },
		region: row.region,
		offer: {
			id: row.offer,
			name: row.offerName,
			vcpus: row.vcpus,
			memoryMb: row.memoryMb,
			gpu: row.gpu ?? null,
			hourly: row.hourly
		},
		environment: env ?? null,
		orphaned: row.forEnvironment && !row.environmentId,
		minNodes: row.minNodes,
		maxNodes: row.maxNodes,
		idleMinutes: row.idleMinutes,
		monthlyCap: row.monthlyCap,
		nodes: nodes.map((n) => ({
			id: n.id,
			name: n.name,
			idleSince: n.idleSince?.toISOString() ?? null
		})),
		provisioning: waiting,
		monthly: now === null ? null : { now, max: monthly(row, row.maxNodes)! },
		removing: row.removing,
		error: row.error,
		errorAt: row.errorAt?.toISOString() ?? null,
		activity: row.activity,
		activityAt: row.activityAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString()
	};
}

function requirePool(ctx: Ctx, id: string) {
	const row = ctx.db.select().from(nodePool).where(eq(nodePool.id, id)).get();
	if (!row) throw notFound('Node pool');
	return row;
}

function checkLimits(limits: { maxNodes: number; minNodes: number }) {
	if (limits.minNodes > limits.maxNodes) {
		throw new AppError('validation_failed', 'The minimum is more than the maximum');
	}
}

export function list(ctx: Ctx): NodePool[] {
	requireInstallAdmin(ctx, 'see node pools');
	return ctx.db
		.select()
		.from(nodePool)
		.orderBy(asc(nodePool.createdAt))
		.all()
		.map((row) => toDto(ctx.db, row));
}

/**
 * A pool on an account, in one region, of one size. The size and price come
 * from the account's offers now, and are kept: they decide what fits on its
 * machines, and what it can cost.
 */
export async function create(ctx: Ctx, input: CreateNodePool, origin: string): Promise<NodePool> {
	requireInstallAdmin(ctx, 'create node pools');
	const parsed = CreateSchema.parse(input);
	const account = requireAccount(ctx, parsed.account);
	if (
		ctx.db.select({ id: nodePool.id }).from(nodePool).where(eq(nodePool.name, parsed.name)).get()
	) {
		throw new AppError('conflict', `There is already a node pool called ${parsed.name}`);
	}
	if (parsed.environmentId) environments.get(ctx, parsed.environmentId);
	const { adapter, creds } = connect(ctx, account);
	if (adapter.capabilities.inventory === false) {
		throw new AppError(
			'validation_failed',
			`${adapter.meta.name} can't create machines by itself, so it can't back a node pool`
		);
	}
	const offers = await call(account, () => adapter.listOffers(creds, parsed.region));
	const offer = offers.find((o) => o.id === parsed.offer);
	if (!offer)
		throw new AppError('validation_failed', `${parsed.offer} isn't offered in ${parsed.region}`);
	const row = ctx.db
		.insert(nodePool)
		.values({
			id: newId('nodePool'),
			name: parsed.name,
			adapterAccountId: account.id,
			region: parsed.region,
			offer: offer.id,
			offerName: offer.name,
			vcpus: offer.vcpus,
			memoryMb: offer.memoryMb,
			gpu: offer.gpu,
			hourly: offer.hourly,
			forEnvironment: !!parsed.environmentId,
			environmentId: parsed.environmentId,
			minNodes: parsed.minNodes,
			maxNodes: parsed.maxNodes,
			idleMinutes: parsed.idleMinutes,
			monthlyCap: parsed.monthlyCap,
			origin: origin.replace(/\/$/, ''),
			createdBy: ctx.userId
		})
		.returning()
		.get();
	notifyNodes();
	return toDto(ctx.db, row);
}

export function update(ctx: Ctx, id: string, input: UpdateNodePool): NodePool {
	requireInstallAdmin(ctx, 'change node pools');
	const row = requirePool(ctx, id);
	const next = { ...row, ...input };
	checkLimits(next);
	ctx.db
		.update(nodePool)
		// new limits get a fresh try at the provider
		.set({ ...input, error: null, errorAt: null })
		.where(eq(nodePool.id, id))
		.run();
	notifyNodes();
	return toDto(ctx.db, requirePool(ctx, id));
}

/**
 * Removes a pool and destroys its machines. Ones running deployments are
 * drained first: the pool is marked as removing, and the autoscaler destroys
 * each machine once it's empty, then forgets the pool. A machine holding a
 * service's data stops it, as it would stop removing the node.
 */
export async function remove(ctx: Ctx, id: string): Promise<NodePool | null> {
	requireInstallAdmin(ctx, 'remove node pools');
	requirePool(ctx, id);
	const nodes = members(ctx.db, id);
	if (nodes.length) {
		const data = ctx.db
			.select({ node: node.name })
			.from(volume)
			.innerJoin(node, eq(node.id, volume.nodeId))
			.where(eq(node.poolId, id))
			.all();
		if (data.length) {
			throw new AppError(
				'conflict',
				`${[...new Set(data.map((d) => d.node))].join(', ')} ${data.length === 1 ? 'holds' : 'hold'} a service's data. Delete those services or restore them elsewhere first.`
			);
		}
	}
	ctx.db
		.update(nodePool)
		.set({ removing: true, minNodes: 0, maxNodes: 0 })
		.where(eq(nodePool.id, id))
		.run();
	for (const n of nodes) {
		if (!n.draining) drainNode(ctx, n);
	}
	await shrinkRemoving(ctx, requirePool(ctx, id));
	const left = ctx.db.select().from(nodePool).where(eq(nodePool.id, id)).get();
	return left ? toDto(ctx.db, left) : null;
}

/** A context for what a pool does by itself, as the person who made it. */
function poolCtx(db: Db, secrets: Secrets, settings: PlatformSettings, row: PoolRow): Ctx {
	return { db, secrets, settings, userId: row.createdBy ?? 'system', organizationId: '' };
}

function note(db: Db, id: string, activity: string, now: number) {
	db.update(nodePool)
		.set({ activity, activityAt: new Date(now), error: null, errorAt: null })
		.where(eq(nodePool.id, id))
		.run();
}

function fail(db: Db, id: string, error: unknown, now: number) {
	const message = error instanceof Error ? error.message : String(error);
	db.update(nodePool)
		.set({ error: message, errorAt: new Date(now) })
		.where(eq(nodePool.id, id))
		.run();
}

/** Deployments on a node, live or about to be. */
function busy(db: Db, nodeId: string) {
	return !!db
		.select({ id: deployment.id })
		.from(deployment)
		.where(and(onNode(nodeId), inArray(deployment.status, [...LIVE, 'queued'])))
		.get();
}

function holdsData(db: Db, nodeId: string) {
	return !!db.select({ id: volume.id }).from(volume).where(eq(volume.nodeId, nodeId)).get();
}

/**
 * Deployments a new machine in this pool would take: queued long enough to
 * have found no room, not tied to another node by data or a pin, in the
 * pool's environment, and small enough for its size.
 */
export function waitingFor(db: Db, row: PoolRow, now: number) {
	if (row.forEnvironment && !row.environmentId) return [];
	return db
		.select()
		.from(deployment)
		.where(eq(deployment.status, 'queued'))
		.all()
		.filter((dep) => {
			if (now - dep.createdAt.getTime() < WAITING_MS) return false;
			if (row.forEnvironment && dep.environmentId !== row.environmentId) return false;
			if (dep.config.deploy.node) return false;
			if (dep.config.volume?.mountPath && volumeFor(db, dep.serviceId, dep.environmentId)?.nodeId) {
				return false;
			}
			// GPU machines are dear: they're only added for work that needs their GPUs
			const gpus = gpuRequest(dep.config);
			if (row.gpu ? !gpus || !offerFits(row.gpu, gpus) : gpus) return false;
			const one = replicaRequest(dep.config);
			// replicas of a registry image spread over machines; anything else needs them all on one
			const together =
				dep.config.source?.type === 'image' || dep.config.deploy.cronSchedule
					? 1
					: dep.config.deploy.replicas;
			return (
				one.memoryMb * together <= row.memoryMb * USABLE_MEMORY &&
				one.cpus * together <= row.vcpus &&
				(!gpus || gpus.count * together <= row.gpu!.count)
			);
		});
}

/** One machine more, if the pool's maximum and spend cap allow it. */
function roomToGrow(row: PoolRow, machines: number) {
	if (machines >= row.maxNodes) return false;
	if (row.monthlyCap !== null && row.hourly !== null) {
		return monthly(row, machines + 1)! <= row.monthlyCap;
	}
	return true;
}

async function grow(ctx: Ctx, row: PoolRow, reason: string, now: number) {
	const account = requireAccount(ctx, row.adapterAccountId);
	const name = `${row.name}-${randomBytes(2).toString('hex')}`;
	try {
		const origin = row.origin;
		await provisionMachine(
			ctx,
			account,
			{
				name,
				region: row.region,
				offer: row.offer,
				cordoned: false,
				poolId: row.id,
				gpu: row.gpu ?? null
			},
			origin
		);
		note(ctx.db, row.id, `Adding ${name} ${reason}`, now);
		console.log(`[pools] ${row.name}: adding ${name} ${reason}`);
	} catch (error) {
		fail(ctx.db, row.id, error, now);
		console.error(`[pools] ${row.name}: couldn't add a machine:`, error);
	}
}

/** Destroys a pool machine that runs nothing; false when it can't go yet. */
async function shrink(ctx: Ctx, row: PoolRow, target: typeof node.$inferSelect, now: number) {
	try {
		// nothing new lands on it while its machine is destroyed
		ctx.db.update(node).set({ cordoned: true }).where(eq(node.id, target.id)).run();
		await removeNode(ctx, { ...target, cordoned: true });
		note(ctx.db, row.id, `Removed ${target.name}, which was idle`, now);
		console.log(`[pools] ${row.name}: removed ${target.name}`);
		return true;
	} catch (error) {
		ctx.db.update(node).set({ cordoned: target.cordoned }).where(eq(node.id, target.id)).run();
		fail(ctx.db, row.id, error, now);
		return false;
	}
}

/** A removing pool destroys each machine once it has drained, then goes itself. */
async function shrinkRemoving(ctx: Ctx, row: PoolRow, now = Date.now()) {
	for (const token of pending(ctx.db, row.id)) {
		await destroyPending(ctx, token).catch((error) => fail(ctx.db, row.id, error, now));
	}
	for (const n of members(ctx.db, row.id)) {
		if (busy(ctx.db, n.id) || holdsData(ctx.db, n.id)) continue;
		await removeNode(ctx, n).catch((error) => fail(ctx.db, row.id, error, now));
	}
	if (!members(ctx.db, row.id).length && !pending(ctx.db, row.id).length) {
		ctx.db.transaction((tx) => {
			// the columns predate ON DELETE SET NULL
			tx.update(joinToken).set({ poolId: null }).where(eq(joinToken.poolId, row.id)).run();
			tx.delete(nodePool).where(eq(nodePool.id, row.id)).run();
		});
		console.log(`[pools] removed ${row.name}`);
	}
	notifyNodes();
}

/**
 * One autoscaler pass over every pool:
 *
 * - machines that never enrolled (their join token expired) are destroyed;
 * - below its minimum, or with work waiting that would fit, a pool adds one
 *   machine at a time, within its maximum and spend cap;
 * - a machine that has run nothing for `idleMinutes` is removed, down to the
 *   minimum. Machines holding data, serving as edge nodes or running the
 *   tunnel's connector stay.
 */
export async function autoscale(
	db: Db,
	secrets: Secrets,
	settings: PlatformSettings,
	now = Date.now()
) {
	const connector = db.select({ nodeId: publicTunnel.nodeId }).from(publicTunnel).get()?.nodeId;
	for (const row of db.select().from(nodePool).all()) {
		const ctx = poolCtx(db, secrets, settings, row);
		if (row.removing) {
			await shrinkRemoving(ctx, row, now);
			continue;
		}
		const backingOff = row.errorAt && now - row.errorAt.getTime() < ERROR_BACKOFF_MS;

		// machines that never enrolled: destroyed, and counted as an error, which backs off
		const expired = pending(db, row.id).filter((t) => t.expiresAt.getTime() <= now);
		for (const token of expired) {
			await destroyPending(ctx, token)
				.then(() =>
					fail(db, row.id, `${token.name} didn't enroll within an hour, so it was destroyed`, now)
				)
				.catch((error) => fail(db, row.id, error, now));
		}
		if (expired.length) continue;

		const nodes = members(db, row.id);
		const waiting = pending(db, row.id);
		const minNodes = row.forEnvironment && !row.environmentId ? 0 : row.minNodes;

		// idle bookkeeping, for every machine
		for (const n of nodes) {
			const idle = !busy(db, n.id);
			if (idle && !n.idleSince) {
				db.update(node)
					.set({ idleSince: new Date(now) })
					.where(eq(node.id, n.id))
					.run();
				n.idleSince = new Date(now);
			} else if (!idle && n.idleSince) {
				db.update(node).set({ idleSince: null }).where(eq(node.id, n.id)).run();
				n.idleSince = null;
			}
		}

		// grow: one machine at a time, once the last one has settled
		// a machine that just joined may still be about to take the waiting work
		const settling = nodes.some(
			(n) => now - n.createdAt.getTime() < SETTLING_MS && (!isOnline(n, now) || !!n.idleSince)
		);
		const machines = nodes.length + waiting.length;
		if (!backingOff && !waiting.length && !settling && roomToGrow(row, machines)) {
			if (machines < minNodes) {
				await grow(ctx, row, `to keep ${minNodes} machine${minNodes === 1 ? '' : 's'}`, now);
				continue;
			}
			const work = waitingFor(db, row, now);
			if (work.length) {
				await grow(
					ctx,
					row,
					`for ${work.length} waiting deployment${work.length === 1 ? '' : 's'}`,
					now
				);
				continue;
			}
		}

		// shrink: the longest idle first, one per pass
		if (nodes.length > minNodes && !waitingFor(db, row, now).length) {
			const idle = nodes
				.filter(
					(n) =>
						n.idleSince &&
						now - n.idleSince.getTime() >= row.idleMinutes * 60_000 &&
						!n.edge &&
						n.id !== connector &&
						!holdsData(db, n.id)
				)
				.sort((a, b) => a.idleSince!.getTime() - b.idleSince!.getTime());
			if (idle[0]) await shrink(ctx, row, idle[0], now);
		}
	}
}
