import type { AgentHello } from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { node } from '../db/schema';
import type { Ctx } from '../domain/context';
import * as nodes from '../domain/nodes';
import { grantInstallAdmin, seedCtx, testSecrets } from '../testing';
import { autoUpdateAgents, ROLLOUT_WATCH_MS } from './auto-update';
import { answer, ask, pendingQueries } from './queries';
import { join, recordHello, recordReport } from './registry';

const HOUR = 3600_000;

const hello = (features: string[] = ['self-update']): AgentHello => ({
	protocol: 1,
	agentVersion: 'test',
	hostname: 'box',
	os: 'linux',
	arch: 'amd64',
	cpus: 4,
	memoryMb: 8192,
	docker: { version: '27.0.0' },
	features,
	image: { reference: 'ghcr.io/jtcorrin/tramline-agent:latest', id: 'sha256:' + 'ab'.repeat(32) }
});

function setup(agentUpdateHours = 6) {
	const ctx = grantInstallAdmin(seedCtx());
	ctx.settings = {
		...ctx.settings,
		agentUpdateHours,
		dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-auto-update-'))
	};
	return ctx;
}

/** A node that joined `age` ago and is online now. */
function enroll(ctx: Ctx, name: string, age: number, features?: string[]) {
	const created = nodes.createJoinToken(ctx, { name }, 'http://tramline.test');
	const { nodeId } = join(ctx.db, created.token, hello(features));
	recordHello(ctx.db, nodeId, hello(features));
	recordReport(ctx.db, nodeId, { containers: [], revision: null });
	ctx.db
		.update(node)
		.set({ createdAt: new Date(Date.now() - age) })
		.where(eq(node.id, nodeId))
		.run();
	return nodeId;
}

const row = (ctx: Ctx, id: string) => ctx.db.select().from(node).where(eq(node.id, id)).get()!;
const run = (ctx: Ctx, now = Date.now()) =>
	autoUpdateAgents(ctx.db, testSecrets, ctx.settings, now);
/** Every node, except `except`, reporting at `at`. */
const seen = (ctx: Ctx, at: number, except?: string) => {
	for (const n of ctx.db.select().from(node).all()) {
		if (n.id === except) continue;
		ctx.db
			.update(node)
			.set({ lastSeenAt: new Date(at) })
			.where(eq(node.id, n.id))
			.run();
	}
};

/** The agent finishing the update it was asked for. */
function finish(ctx: Ctx, id: string, detail = 'Already up to date (abababababab)') {
	const update = row(ctx, id).agentUpdate!;
	recordReport(ctx.db, id, {
		containers: [],
		revision: null,
		agentUpdate: { id: update.id, state: 'succeeded', size: null, detail, error: null }
	});
}

describe('automatic agent updates', () => {
	it('updates nodes one at a time, the longest waiting first, then waits for the interval', () => {
		const ctx = setup();
		const newer = enroll(ctx, 'newer', 7 * HOUR);
		const older = enroll(ctx, 'older', 9 * HOUR);
		const fresh = enroll(ctx, 'fresh', HOUR);

		expect(run(ctx)).toBe(older);
		expect(row(ctx, older).agentUpdate).toMatchObject({ state: 'requested', requestedBy: null });
		const summary = nodes.list(ctx).find((n) => n.id === older)!;
		expect(summary.agent.update?.automatic).toBe(true);
		// nothing else starts while it runs
		expect(run(ctx)).toBeNull();

		finish(ctx, older);
		expect(run(ctx)).toBe(newer);
		finish(ctx, newer);
		// the fresh node isn't due yet, and the others just updated
		expect(run(ctx)).toBeNull();
		const later = Date.now() + 6 * HOUR;
		seen(ctx, later);
		// by then the fresh node, which has never been checked, has waited longest
		expect(run(ctx, later)).toBe(fresh);
	});

	it('skips agents that cannot update themselves, offline nodes, and busy ones', async () => {
		const ctx = setup();
		enroll(ctx, 'old-agent', 9 * HOUR, []);
		const away = enroll(ctx, 'away', 9 * HOUR);
		ctx.db
			.update(node)
			.set({ lastSeenAt: new Date(Date.now() - HOUR) })
			.where(eq(node.id, away))
			.run();
		const busy = enroll(ctx, 'busy', 9 * HOUR);
		const query = ask(busy, 'tl-db', 'select 1');
		expect(run(ctx)).toBeNull();

		const [pending] = pendingQueries(busy);
		answer(busy, pending!.id, { ok: true, json: '[]' });
		await query.catch(() => {});
		expect(run(ctx)).toBe(busy);
	});

	it('stops the rollout while a node it just updated is offline', () => {
		const ctx = setup();
		const first = enroll(ctx, 'first', 10 * HOUR);
		const second = enroll(ctx, 'second', 9 * HOUR);
		expect(run(ctx)).toBe(first);
		finish(ctx, first, 'Updated from 111111111111 to 222222222222');
		ctx.db
			.update(node)
			.set({ lastSeenAt: new Date(Date.now() - HOUR) })
			.where(eq(node.id, first))
			.run();
		expect(run(ctx)).toBeNull();
		// an hour on, it's someone's to look at; the rest carry on
		const later = Date.now() + ROLLOUT_WATCH_MS + 1000;
		seen(ctx, later, first);
		expect(run(ctx, later)).toBe(second);
	});

	it('does nothing when turned off', () => {
		const ctx = setup(0);
		enroll(ctx, 'box', 100 * HOUR);
		expect(run(ctx)).toBeNull();
	});

	it("doesn't wait on an update someone asked for that never finished", () => {
		const ctx = setup();
		const stuck = enroll(ctx, 'stuck', 10 * HOUR);
		const other = enroll(ctx, 'other', 9 * HOUR);
		nodes.updateAgent(ctx, stuck);
		expect(row(ctx, stuck).agentUpdate?.requestedBy).not.toBeNull();
		expect(run(ctx)).toBeNull();
		// past the 15 minute timeout it counts as failed, and the rollout moves on
		const later = Date.now() + 16 * 60_000;
		seen(ctx, later);
		expect(run(ctx, later)).toBe(other);
	});
});
