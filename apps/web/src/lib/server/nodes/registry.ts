import type { AgentHello, AgentReportInput } from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DbOrTx } from '../db/client';
import { build, container, node } from '../db/schema';
import { newId } from '../ids';
import { notifyNodes } from './bus';

/** A node counts as online if its agent reported within this window. */
export const ONLINE_WINDOW_MS = 30_000;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export type NodeRow = typeof node.$inferSelect;

export function isOnline(row: NodeRow, now = Date.now()) {
	return Boolean(
		row.lastSeenAt &&
		now - row.lastSeenAt.getTime() < ONLINE_WINDOW_MS &&
		!row.error &&
		row.info?.docker
	);
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

	const token = `tlnode_${randomBytes(32).toString('base64url')}`;
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
		tx.delete(build).where(eq(build.nodeId, nodeId)).run();
		for (const b of report.builds ?? []) {
			tx.insert(build)
				.values({
					deploymentId: b.deploymentId,
					nodeId,
					state: b.state,
					image: b.image,
					commit: b.commit,
					error: b.error
				})
				.run();
		}
		tx.update(node)
			.set({ lastSeenAt: new Date(), revision: report.revision, error: report.dockerError ?? null })
			.where(eq(node.id, nodeId))
			.run();
	});
}
