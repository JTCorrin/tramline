import type { AgentHello, AgentJoined, AgentReportInput } from '@tramline/contracts';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DbOrTx } from '../db/client';
import { AppError } from '../api/errors';
import { adapterAccount, build, container, deployment, joinToken, node } from '../db/schema';
import { newId } from '../ids';
import { notifyNodes } from './bus';
import { recordVolumes } from './volumes';
import { recordJobReports } from '../domain/backups';

/** A node counts as online if its agent reported within this window. */
export const ONLINE_WINDOW_MS = 30_000;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export type NodeRow = typeof node.$inferSelect;

const newNodeToken = () => `tlnode_${randomBytes(32).toString('base64url')}`;

export function isOnline(row: NodeRow, now = Date.now()) {
	return Boolean(
		row.lastSeenAt &&
		now - row.lastSeenAt.getTime() < ONLINE_WINDOW_MS &&
		!row.error &&
		row.info?.docker
	);
}

/** Memory a deployment reserves on its node: its limit times its replicas, 0 without a limit. */
export function requestedMemory(config: {
	deploy: { memoryMb?: number | null; replicas: number };
}) {
	return (config.deploy.memoryMb ?? 0) * config.deploy.replicas;
}

export function nodeStatus(row: NodeRow, now = Date.now()) {
	if (!row.lastSeenAt || now - row.lastSeenAt.getTime() >= ONLINE_WINDOW_MS) return 'offline';
	return row.error || !row.info?.docker ? 'error' : 'online';
}

/**
 * Makes sure the install has its built-in `local` node, for the agent that
 * runs next to the control plane. Its token is written to
 * `<dataDir>/local-agent.token` (mode 600) for that agent to read.
 */
export function ensureLocalNode(db: DbOrTx, dataDir: string) {
	const tokenFile = path.join(dataDir, 'local-agent.token');
	const existing = db.select().from(node).where(eq(node.name, 'local')).get();
	if (existing && existsSync(tokenFile)) {
		const token = readFileSync(tokenFile, 'utf8').trim();
		if (hashToken(token) === existing.tokenHash) return { node: existing, tokenFile };
	}

	const token = newNodeToken();
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(tokenFile, token + '\n', { mode: 0o600 });

	const row = existing
		? db
				.update(node)
				.set({ tokenHash: hashToken(token) })
				.where(eq(node.id, existing.id))
				.returning()
				.get()!
		: db
				.insert(node)
				.values({ id: newId('node'), name: 'local', tokenHash: hashToken(token), edge: true })
				.returning()
				.get();
	return { node: row, tokenFile };
}

/**
 * Enrolls a machine: a valid, unused join token becomes a node with its own
 * token, which only the agent ever sees. The join token can't be used again.
 */
export function join(db: DbOrTx, token: string, hello: AgentHello, now = new Date()): AgentJoined {
	return db.transaction((tx) => {
		const invite = tx
			.select()
			.from(joinToken)
			.where(
				and(
					eq(joinToken.tokenHash, hashToken(token)),
					isNull(joinToken.usedAt),
					gt(joinToken.expiresAt, now)
				)
			)
			.get();
		// one message for unknown, used and expired tokens alike
		if (!invite) throw new AppError('unauthenticated', 'This join token is invalid or has expired');
		if (tx.select({ id: node.id }).from(node).where(eq(node.name, invite.name)).get()) {
			throw new AppError('conflict', `There is already a node called ${invite.name}`);
		}
		const nodeToken = newNodeToken();
		const row = tx
			.insert(node)
			.values({
				id: newId('node'),
				name: invite.name,
				tokenHash: hashToken(nodeToken),
				cordoned: invite.cordoned,
				// a machine an adapter created stays linked to it, to be destroyed with the node
				...(invite.adapterAccountId
					? {
							adapter: accountAdapter(tx, invite.adapterAccountId),
							adapterAccountId: invite.adapterAccountId,
							providerNodeId: invite.providerNodeId
						}
					: {})
			})
			.returning()
			.get();
		tx.update(joinToken)
			.set({ usedAt: now, nodeId: row.id })
			.where(eq(joinToken.id, invite.id))
			.run();
		recordHello(tx, row.id, hello);
		return { nodeId: row.id, name: row.name, token: nodeToken };
	});
}

const accountAdapter = (db: DbOrTx, id: string) =>
	db
		.select({ adapter: adapterAccount.adapter })
		.from(adapterAccount)
		.where(eq(adapterAccount.id, id))
		.get()?.adapter ?? 'manual';

export function authenticate(db: DbOrTx, token: string | null) {
	if (!token) return undefined;
	return db
		.select()
		.from(node)
		.where(eq(node.tokenHash, hashToken(token)))
		.get();
}

export function recordHello(db: DbOrTx, nodeId: string, hello: AgentHello) {
	const row = db.select().from(node).where(eq(node.id, nodeId)).get();
	const mesh = hello.mesh;
	db.update(node)
		.set({
			info: hello,
			error: hello.docker ? null : (hello.dockerError ?? 'Docker is unavailable'),
			lastSeenAt: new Date(),
			...(mesh
				? {
						meshPublicKey: mesh.publicKey,
						meshAddress: row?.meshAddress ?? nextMeshAddress(db),
						// an address the agent was configured with wins; otherwise keep what an admin set
						meshEndpoint: mesh.endpoint ?? row?.meshEndpoint ?? null
					}
				: {})
		})
		.where(eq(node.id, nodeId))
		.run();
	notifyNodes();
}

/** The mesh's private range. Docker's default pools and the CGNAT range Tailscale uses are avoided. */
export const MESH_CIDR = '10.231.0.0/16';

/** The lowest free address in the mesh range, from 10.231.0.1. */
export function nextMeshAddress(db: DbOrTx) {
	const taken = new Set(
		db
			.select({ address: node.meshAddress })
			.from(node)
			.all()
			.map((row) => row.address)
	);
	for (let n = 1; n < 65_535; n++) {
		const address = `10.231.${n >> 8}.${n & 255}`;
		if ((n & 255) !== 0 && (n & 255) !== 255 && !taken.has(address)) return address;
	}
	throw new Error('The mesh has no addresses left');
}

/** Replaces the node's container rows with what the agent just observed. */
export function recordReport(db: DbOrTx, nodeId: string, report: AgentReportInput) {
	db.transaction((tx) => {
		// a node speaks only for deployments placed on it: a report about another node's
		// deployment (a stolen node token, or a stale one) is ignored
		const assigned = new Set(
			tx
				.select({ id: deployment.id })
				.from(deployment)
				.where(eq(deployment.nodeId, nodeId))
				.all()
				.map((row) => row.id)
		);
		tx.delete(container).where(eq(container.nodeId, nodeId)).run();
		for (const c of report.containers) {
			if (!assigned.has(c.deploymentId)) continue;
			tx.insert(container)
				.values({
					name: c.name,
					nodeId,
					deploymentId: c.deploymentId,
					replica: c.replica,
					state: c.state,
					healthy: c.healthy,
					exitCode: c.exitCode,
					restartCount: c.restartCount,
					error: c.error,
					startedAt: c.startedAt ? new Date(c.startedAt) : null,
					imageDigest: c.imageDigest ?? null
				})
				.run();
		}
		if (report.volumes) recordVolumes(tx, nodeId, report.volumes);
		recordJobReports(tx, nodeId, {
			backups: report.backups ?? [],
			restores: report.restores ?? [],
			drills: report.drills ?? []
		});
		tx.delete(build).where(eq(build.nodeId, nodeId)).run();
		for (const b of report.builds ?? []) {
			if (!assigned.has(b.deploymentId)) continue;
			tx.insert(build)
				.values({
					deploymentId: b.deploymentId,
					nodeId,
					state: b.state,
					image: b.image,
					commit: b.commit,
					error: b.error,
					scan: b.scan ?? null
				})
				.run();
		}
		tx.update(node)
			.set({ lastSeenAt: new Date(), revision: report.revision, error: report.dockerError ?? null })
			.where(eq(node.id, nodeId))
			.run();
	});
}
