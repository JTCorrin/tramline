import type { AgentHello, AgentJoined, AgentReportInput } from '@tramline/contracts';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DbOrTx } from '../db/client';
import { AppError } from '../api/errors';
import { build, container, joinToken, node } from '../db/schema';
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
				.values({ id: newId('node'), name: 'local', tokenHash: hashToken(token) })
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
				cordoned: invite.cordoned
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

export function authenticate(db: DbOrTx, token: string | null) {
	if (!token) return undefined;
	return db
		.select()
		.from(node)
		.where(eq(node.tokenHash, hashToken(token)))
		.get();
}

export function recordHello(db: DbOrTx, nodeId: string, hello: AgentHello) {
	db.update(node)
		.set({
			info: hello,
			error: hello.docker ? null : (hello.dockerError ?? 'Docker is unavailable'),
			lastSeenAt: new Date()
		})
		.where(eq(node.id, nodeId))
		.run();
	notifyNodes();
}

/** Replaces the node's container rows with what the agent just observed. */
export function recordReport(db: DbOrTx, nodeId: string, report: AgentReportInput) {
	db.transaction((tx) => {
		tx.delete(container).where(eq(container.nodeId, nodeId)).run();
		for (const c of report.containers) {
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
