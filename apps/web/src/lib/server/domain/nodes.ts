import type {
	CreatedJoinToken,
	CreateJoinToken,
	DrainResult,
	NodeSummary,
	UpdateNode
} from '@tramline/contracts';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { AppError, notFound } from '../api/errors';
import type { DbOrTx } from '../db/client';
import { adapterAccount, deployment, joinToken, node, service, volume } from '../db/schema';
import { newId } from '../ids';
import { notifyNodes } from '../nodes/bus';
import { meshMembers, routes } from '../nodes/mesh';
import { hashToken, nodeStatus, requestedMemory } from '../nodes/registry';
import { requireInstallAdmin } from './admins';
import type { Ctx } from './context';
import { destroyMachine } from './adapters';
import { copyDeployment } from './deployments';

/** How long a join token can be used for. */
export const JOIN_TOKEN_TTL_MS = 60 * 60_000;

/** Deployments that hold a place on a node. */
const LIVE = ['building', 'deploying', 'active', 'crashed'] as const;

/** Nodes are shared by every organization on the install. */
export function list(ctx: Ctx): NodeSummary[] {
	const placed = Map.groupBy(
		ctx.db
			.select({ nodeId: deployment.nodeId, config: deployment.config })
			.from(deployment)
			.where(inArray(deployment.status, [...LIVE]))
			.all(),
		(row) => row.nodeId
	);
	const members = meshMembers(ctx.db);
	const accounts = new Map(
		ctx.db
			.select({ id: adapterAccount.id, name: adapterAccount.name })
			.from(adapterAccount)
			.all()
			.map((a) => [a.id, a])
	);
	return ctx.db
		.select()
		.from(node)
		.orderBy(asc(node.createdAt))
		.all()
		.map((row) => {
			const here = placed.get(row.id) ?? [];
			const me = members.find((m) => m.id === row.id);
			const reach = me && members.length > 1 ? routes(members, me) : null;
			return {
				id: row.id,
				name: row.name,
				status: nodeStatus(row),
				error: row.error,
				lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
				hostname: row.info?.hostname ?? null,
				dockerVersion: row.info?.docker?.version ?? null,
				adapter: row.adapter,
				account: (row.adapterAccountId && accounts.get(row.adapterAccountId)) || null,
				cpus: row.info?.cpus ?? null,
				memoryMb: row.info?.memoryMb ?? null,
				gpus: row.info?.gpus ?? [],
				allocatedMemoryMb: here.reduce((sum, d) => sum + requestedMemory(d.config), 0),
				deployments: here.length,
				cordoned: row.cordoned,
				draining: row.draining,
				edge: row.edge,
				mesh: row.meshAddress
					? {
							address: row.meshAddress,
							endpoint: row.meshEndpoint,
							unreachable: reach?.unreachable.map((m) => m.name) ?? [],
							relayed: reach?.relayed.map((r) => ({ node: r.node.name, via: r.via.name })) ?? []
						}
					: null,
				createdAt: row.createdAt.toISOString()
			};
		});
}

function nameTaken(db: DbOrTx, name: string, now: Date) {
	if (db.select({ id: node.id }).from(node).where(eq(node.name, name)).get()) return true;
	return !!db
		.select({ id: joinToken.id })
		.from(joinToken)
		.where(and(eq(joinToken.name, name), isNull(joinToken.usedAt), gt(joinToken.expiresAt, now)))
		.get();
}

/**
 * A one-time token for enrolling a machine; the response holds the only copy.
 * `origin` is where the new node reaches this install when TRAMLINE_URL isn't set.
 */
export function createJoinToken(
	ctx: Ctx,
	input: CreateJoinToken,
	origin: string,
	now = new Date()
): CreatedJoinToken {
	requireInstallAdmin(ctx, 'add nodes');
	const { name, token, expiresAt, command } = issueJoinToken(ctx, input, origin, {}, now);
	return { name, token, expiresAt, command };
}

/** Stores a join token, with what an adapter will record about the machine it makes. */
export function issueJoinToken(
	ctx: Ctx,
	input: CreateJoinToken,
	origin: string,
	adapter: { adapterAccountId?: string; region?: string; offer?: string },
	now = new Date()
) {
	if (nameTaken(ctx.db, input.name, now)) {
		throw new AppError('conflict', `There is already a node called ${input.name}`);
	}
	const token = `tljoin_${randomBytes(24).toString('base64url')}`;
	const expiresAt = new Date(now.getTime() + JOIN_TOKEN_TTL_MS);
	const id = newId('join');
	ctx.db
		.insert(joinToken)
		.values({
			id,
			tokenHash: hashToken(token),
			name: input.name,
			cordoned: input.cordoned ?? false,
			createdBy: ctx.userId,
			expiresAt,
			...adapter
		})
		.run();
	const url = (ctx.settings.publicUrl ?? origin).replace(/\/$/, '');
	return {
		id,
		url,
		name: input.name,
		token,
		expiresAt: expiresAt.toISOString(),
		command: `curl -fsSL ${url}/install.sh | sudo sh -s -- --url ${url} --token ${token}`
	};
}

function requireNode(ctx: Ctx, id: string) {
	const row = ctx.db.select().from(node).where(eq(node.id, id)).get();
	if (!row) throw notFound('Node');
	return row;
}

/**
 * Cordoning stops new deployments landing on a node, and uncordoning also
 * ends a drain. An edge node serves every public domain; the mesh endpoint
 * is where other nodes reach this one.
 */
export function update(ctx: Ctx, id: string, input: UpdateNode) {
	requireInstallAdmin(ctx, 'change nodes');
	requireNode(ctx, id);
	const changes = {
		...(input.cordoned === true ? { cordoned: true } : {}),
		...(input.cordoned === false ? { cordoned: false, draining: false } : {}),
		...(input.edge !== undefined ? { edge: input.edge } : {}),
		...(input.meshEndpoint !== undefined ? { meshEndpoint: input.meshEndpoint } : {})
	};
	if (Object.keys(changes).length) {
		ctx.db.update(node).set(changes).where(eq(node.id, id)).run();
	}
	notifyNodes();
	return list(ctx).find((n) => n.id === id)!;
}

/**
 * Cordons a node and moves its stateless deployments elsewhere. Each move is
 * an ordinary redeploy, so the old containers keep serving until the new ones
 * are healthy. Services with a volume stay, since their data is on this node.
 */
export function drain(ctx: Ctx, id: string): DrainResult {
	requireInstallAdmin(ctx, 'drain nodes');
	const target = requireNode(ctx, id);
	return ctx.db.transaction((tx) => {
		tx.update(node).set({ cordoned: true, draining: true }).where(eq(node.id, id)).run();
		const here = tx
			.select({ deployment, service: service.name })
			.from(deployment)
			.innerJoin(service, eq(service.id, deployment.serviceId))
			.where(and(eq(deployment.nodeId, id), inArray(deployment.status, [...LIVE])))
			.all();
		const kept: DrainResult['kept'] = [];
		let moved = 0;
		for (const { deployment: dep, service: name } of here) {
			if (dep.config.volume?.mountPath) {
				kept.push({ deploymentId: dep.id, service: name });
				continue;
			}
			// a pinned service can only move if its pin changes
			if (dep.config.deploy.node === id) {
				kept.push({ deploymentId: dep.id, service: name });
				continue;
			}
			copyDeployment(tx, dep, {
				createdBy: ctx.userId,
				dataDir: ctx.settings.dataDir,
				log: `Moving off ${target.name}, which is draining`,
				// a built image only exists on the node that built it
				rebuild: true
			});
			moved++;
		}
		notifyNodes();
		return { moved, kept };
	});
}

/**
 * Forgets a node and revokes its token. It must have nothing placed on it.
 * A machine an adapter created is destroyed first; if that fails, the node stays.
 */
export async function remove(ctx: Ctx, id: string) {
	requireInstallAdmin(ctx, 'remove nodes');
	const row = requireNode(ctx, id);
	if (row.name === 'local') {
		throw new AppError(
			'conflict',
			'The local node runs next to Tramline and comes back on restart. Cordon it instead.'
		);
	}
	const placed = ctx.db
		.select({ id: deployment.id })
		.from(deployment)
		.where(and(eq(deployment.nodeId, id), inArray(deployment.status, [...LIVE, 'queued'])))
		.all();
	if (placed.length) {
		throw new AppError(
			'conflict',
			`${row.name} still runs ${placed.length} deployment${placed.length === 1 ? '' : 's'}. Drain it first.`
		);
	}
	const data = ctx.db
		.select({ service: service.name })
		.from(volume)
		.innerJoin(service, eq(service.id, volume.serviceId))
		.where(eq(volume.nodeId, id))
		.all();
	if (data.length) {
		throw new AppError(
			'conflict',
			`${row.name} holds the data of ${data.map((d) => d.service).join(', ')}. Delete those services or restore them elsewhere first.`
		);
	}
	await destroyMachine(ctx, row);
	ctx.db.transaction((tx) => {
		// finished deployments keep their history; the column predates ON DELETE SET NULL
		tx.update(deployment).set({ nodeId: null }).where(eq(deployment.nodeId, id)).run();
		tx.delete(node).where(eq(node.id, id)).run();
	});
	notifyNodes();
}
