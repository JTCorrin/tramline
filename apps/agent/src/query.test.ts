import type { DesiredQuery, QueryResult } from '@tramline/contracts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Agent } from './agent';
import { MAX_RESULT_BYTES, PSQL, runQuery } from './query';
import { desiredState, FakeRuntime } from './testing';

const query: DesiredQuery = {
	id: 'qry_1',
	container: 'tl-dep_1-0',
	sql: 'BEGIN READ ONLY; SELECT 1; COMMIT;'
};

describe('runQuery', () => {
	it('runs psql in the database container with the SQL in its environment', async () => {
		const runtime = new FakeRuntime();
		runtime.onExec = (_cmd, { stdout }) => {
			stdout!.write('[{"id":1}]\n');
			return 0;
		};
		expect(await runQuery(runtime, query)).toEqual({ ok: true, json: '[{"id":1}]' });
		expect(runtime.execs[0]).toEqual({
			container: 'tl-dep_1-0',
			cmd: ['sh', '-c', PSQL],
			env: { TRAMLINE_SQL: query.sql }
		});
		// the SQL never appears on a command line
		expect(PSQL).not.toContain('SELECT');
	});

	it('reports errors, refuses huge results, and survives a broken runtime', async () => {
		const runtime = new FakeRuntime();
		runtime.onExec = (_cmd, { onLine }) => {
			onLine('stderr', 'ERROR:  relation "nope" does not exist');
			return 3;
		};
		expect(await runQuery(runtime, query)).toEqual({
			ok: false,
			error: 'ERROR:  relation "nope" does not exist'
		});
		runtime.onExec = () => 1;
		expect(await runQuery(runtime, query)).toEqual({ ok: false, error: 'psql exited with 1' });
		runtime.onExec = (_cmd, { stdout }) => {
			stdout!.write(Buffer.alloc(MAX_RESULT_BYTES + 1, 'x'));
			return 0;
		};
		expect(await runQuery(runtime, query)).toEqual({
			ok: false,
			error: 'The result is too large to show'
		});
		runtime.down = true;
		expect((await runQuery(runtime, query)).ok).toBe(false);
	});
});

describe('Agent queries', () => {
	it('answers each query once, straight away', async () => {
		const runtime = new FakeRuntime();
		runtime.onExec = (_cmd, { stdout }) => {
			stdout?.write('[]');
			return 0;
		};
		const answers: [string, QueryResult][] = [];
		const answer = vi.fn(async (id: string, result: QueryResult) => {
			answers.push([id, result]);
		});
		const withQuery = { ...desiredState([]), revision: 'q1', queries: [query] };
		const states = [
			withQuery,
			{ ...withQuery, revision: 'q2' },
			{ ...desiredState([]), revision: 'q3' }
		];
		const agent = new Agent({
			runtime,
			client: {
				hello: async () => ({ nodeId: 'node_1', name: 'local' }),
				desired: async () => states.shift() ?? null,
				report: async () => {},
				logs: async () => {},
				answer
			},
			stateDir: mkdtempSync(path.join(tmpdir(), 'tramline-agent-')),
			version: 'test',
			log: () => {}
		});
		await agent.hello();
		await agent.sync();
		await vi.waitFor(() => expect(answers).toEqual([['qry_1', { ok: true, json: '[]' }]]));
		await agent.sync();
		await agent.sync();
		expect(answer).toHaveBeenCalledTimes(1);
	});
});
