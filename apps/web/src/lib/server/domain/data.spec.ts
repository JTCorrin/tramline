import type { AgentHello } from '@tramline/contracts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildDesiredState, containerName } from '../nodes/desired';
import { answer, ask, pendingQueries } from '../nodes/queries';
import { reconcile } from '../nodes/reconciler';
import { ensureLocalNode, recordHello, recordReport } from '../nodes/registry';
import { seedCtx, testSecrets } from '../testing';
import * as changes from './changes';
import * as data from './data';
import * as environments from './environments';
import * as projects from './projects';
import * as services from './services';

const hello: AgentHello = {
	protocol: 1,
	agentVersion: 'test',
	hostname: 'box',
	os: 'linux',
	arch: 'arm64',
	cpus: 4,
	memoryMb: 8192,
	docker: { version: '27.0.0' }
};

function setup({ deploy = true } = {}) {
	const ctx = seedCtx();
	ctx.settings = { ...ctx.settings, dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-data-')) };
	const { node } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
	recordHello(ctx.db, node.id, hello);
	const project = projects.create(ctx, { name: 'Shop' });
	const [env] = environments.list(ctx, project.id);
	const pg = services.create(ctx, { projectId: project.id, kind: 'database', engine: 'postgres' });
	services.stageConfig(ctx, pg.id, env!.id, { build: { scan: 'off' } });
	let container = '';
	if (deploy) {
		const [dep] = changes.deploy(ctx, env!.id);
		container = containerName(dep!.id, 0);
		reconcile(ctx.db, ctx.settings);
		recordReport(ctx.db, node.id, {
			revision: null,
			containers: [
				{
					name: container,
					deploymentId: dep!.id,
					replica: 0,
					state: 'running',
					healthy: null,
					exitCode: null,
					restartCount: 0,
					error: null,
					startedAt: new Date(Date.now() - 10_000).toISOString()
				}
			]
		});
		reconcile(ctx.db, ctx.settings);
	}
	const query = { serviceId: pg.id, environmentId: env!.id };
	return { ctx, node, env: env!, pg, project, container, query };
}

/** Answers the node's pending queries in order, like an agent would. */
async function respond(nodeId: string, ...answers: string[]) {
	for (const json of answers) {
		await vi.waitFor(() => expect(pendingQueries(nodeId)).toHaveLength(1));
		answer(nodeId, pendingQueries(nodeId)[0]!.id, { ok: true, json });
	}
}

const TABLES = JSON.stringify([
	{ schema: 'public', name: 'notes', estimate: 2 },
	{ schema: 'odd', name: `we"ird'name`, estimate: -1 }
]);

describe('query channel', () => {
	it('delivers queries through the desired state and resolves with the answer', async () => {
		const { ctx, node } = setup({ deploy: false });
		const asked = ask(node.id, 'tl-db-0', 'SELECT 1');
		const [query] = pendingQueries(node.id);
		expect(query).toMatchObject({ container: 'tl-db-0', sql: 'SELECT 1' });
		expect(buildDesiredState(ctx.db, testSecrets, ctx.settings, node.id).queries).toEqual([query]);
		// another node can't answer it
		expect(answer('node_other', query!.id, { ok: true, json: 'nope' })).toBe(false);
		expect(answer(node.id, query!.id, { ok: true, json: '1' })).toBe(true);
		expect(await asked).toBe('1');
		expect(pendingQueries(node.id)).toEqual([]);
	});

	it('turns errors and silence into readable failures', async () => {
		const { node } = setup({ deploy: false });
		const failing = ask(node.id, 'tl-db-0', 'SELECT nope');
		answer(node.id, pendingQueries(node.id)[0]!.id, {
			ok: false,
			error: 'column "nope" does not exist'
		});
		await expect(failing).rejects.toThrow('column "nope" does not exist');
		await expect(ask(node.id, 'tl-db-0', 'SELECT 1', 10)).rejects.toThrow(
			'The node did not answer in time'
		);
		expect(pendingQueries(node.id)).toEqual([]);
	});
});

describe('data browser', () => {
	it('lists tables with read-only SQL in the live database container', async () => {
		const { node, container, ctx, query } = setup();
		const listed = data.tables(ctx, query.serviceId, query.environmentId);
		await vi.waitFor(() => expect(pendingQueries(node.id)).toHaveLength(1));
		const [sent] = pendingQueries(node.id);
		expect(sent!.container).toBe(container);
		expect(sent!.sql).toMatch(/^BEGIN READ ONLY; SET LOCAL statement_timeout = '5s'; SELECT/);
		expect(sent!.sql).toMatch(/; COMMIT;$/);
		answer(node.id, sent!.id, { ok: true, json: TABLES });
		expect(await listed).toEqual(JSON.parse(TABLES));
	});

	it('pages through rows, quoting names safely and cutting long values', async () => {
		const { node, ctx, query } = setup();
		const long = 'x'.repeat(data.MAX_VALUE_LENGTH + 10);
		const page = {
			columns: ['id', 'body'],
			rows: Array.from({ length: data.PAGE_SIZE + 1 }, (_, i) => ({
				id: i,
				body: i ? 'short' : long
			}))
		};
		const loaded = data.rows(ctx, { ...query, schema: 'odd', table: `we"ird'name`, offset: 50.7 });
		await respond(node.id, TABLES);
		await vi.waitFor(() => expect(pendingQueries(node.id)).toHaveLength(1));
		const { sql } = pendingQueries(node.id)[0]!;
		expect(sql).toContain(`FROM "odd"."we""ird'name" LIMIT 51 OFFSET 50`);
		expect(sql).toContain(`quote_ident('we"ird''name')`);
		await respond(node.id, JSON.stringify(page));
		const result = await loaded;
		expect(result).toMatchObject({ columns: ['id', 'body'], offset: 50, hasMore: true });
		expect(result.rows).toHaveLength(data.PAGE_SIZE);
		expect(result.rows[0]!.body).toBe(`${'x'.repeat(data.MAX_VALUE_LENGTH)}…`);
	});

	it('refuses unknown tables, other services and undeployed databases', async () => {
		const { node, ctx, query, project, env } = setup();
		const missing = data.rows(ctx, {
			...query,
			schema: 'public',
			table: 'users; DROP TABLE notes',
			offset: 0
		});
		await respond(node.id, TABLES);
		await expect(missing).rejects.toThrow('Table not found');

		const api = services.create(ctx, {
			projectId: project.id,
			kind: 'image',
			source: { type: 'image', image: 'acme/api' }
		});
		await expect(data.tables(ctx, api.id, env.id)).rejects.toThrow(
			'The data browser is for Postgres services'
		);

		const fresh = setup({ deploy: false });
		await expect(
			data.tables(fresh.ctx, fresh.query.serviceId, fresh.query.environmentId)
		).rejects.toThrow('Deploy the database to browse its data');
	});
});
