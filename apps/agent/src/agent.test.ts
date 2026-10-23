import type { AgentHello, AgentReport, DesiredState, LogLine } from '@tramline/contracts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Agent } from './agent';
import { ControlPlane, ControlPlaneError } from './client';
import { desiredState, FakeRuntime } from './testing';

function fakeClient(desired: (DesiredState | null)[] = []) {
	const calls = {
		hellos: [] as AgentHello[],
		reports: [] as AgentReport[],
		logs: [] as LogLine[][]
	};
	return {
		calls,
		client: {
			hello: vi.fn(async (hello: AgentHello) => {
				calls.hellos.push(hello);
				return { nodeId: 'node_1', name: 'local' };
			}),
			desired: vi.fn(async () => desired.shift() ?? null),
			report: vi.fn(async (report: AgentReport) => {
				calls.reports.push(report);
			}),
			logs: vi.fn(async (lines: LogLine[]) => {
				calls.logs.push(lines);
			})
		}
	};
}

const agentWith = (runtime: FakeRuntime, client: ReturnType<typeof fakeClient>['client']) =>
	new Agent({
		runtime,
		client,
		stateDir: mkdtempSync(path.join(tmpdir(), 'tramline-agent-')),
		version: 'test',
		log: () => {}
	});

describe('Agent', () => {
	it('says hello, converges to the desired state and reports containers', async () => {
		const runtime = new FakeRuntime();
		const { client, calls } = fakeClient([desiredState()]);
		const agent = agentWith(runtime, client);

		await agent.hello();
		expect(calls.hellos[0]).toMatchObject({
			protocol: 1,
			docker: { version: '27.0.0' },
			dockerError: null
		});

		await agent.sync();
		expect(runtime.containers.has('tl-dep_1-0')).toBe(true);
		expect(client.desired).toHaveBeenCalledWith(null, expect.any(AbortSignal));

		await agent.tick();
		expect(calls.reports.at(-1)).toMatchObject({
			revision: desiredState().revision,
			dockerError: null,
			containers: [{ name: 'tl-dep_1-0', state: 'running', deploymentId: 'dep_1' }]
		});

		await agent.sync(); // nothing changed (long-poll timed out)
		expect(client.desired).toHaveBeenLastCalledWith(
			desiredState().revision,
			expect.any(AbortSignal)
		);
	});

	it('reports Docker outages and says hello again when Docker comes back', async () => {
		const runtime = new FakeRuntime();
		const { client, calls } = fakeClient([desiredState()]);
		const agent = agentWith(runtime, client);
		await agent.hello();
		await agent.sync();

		runtime.down = true;
		await agent.tick();
		expect(calls.reports.at(-1)).toMatchObject({
			containers: [],
			dockerError: expect.stringContaining('Docker is unavailable')
		});

		runtime.down = false;
		await agent.tick();
		expect(calls.hellos).toHaveLength(2);
		expect(calls.reports.at(-1)!.dockerError).toBeNull();
	});

	it('does not converge while Docker is down', async () => {
		const runtime = new FakeRuntime();
		runtime.down = true;
		const { client, calls } = fakeClient([desiredState()]);
		const agent = agentWith(runtime, client);
		await agent.hello();
		expect(calls.hellos[0]).toMatchObject({
			docker: null,
			dockerError: expect.stringContaining('ENOENT')
		});
		await agent.sync();
		expect(runtime.containers.size).toBe(0);
	});

	it('runs its loops until stopped, and stops when its token is rejected', async () => {
		const runtime = new FakeRuntime();
		const { client } = fakeClient();
		client.desired.mockRejectedValue(new ControlPlaneError(401, 'Unknown agent token'));
		const agent = new Agent({
			runtime,
			client,
			stateDir: mkdtempSync(path.join(tmpdir(), 'tramline-agent-')),
			version: 'test',
			reportIntervalMs: 10,
			log: () => {}
		});
		await agent.start();
		await vi.waitFor(() => expect(agent.stopped).toBe(true));
	});
});

describe('ControlPlane client', () => {
	it('authenticates, long-polls and maps errors', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
			const u = String(url);
			if (u.endsWith('/hello')) return Response.json({ nodeId: 'node_1', name: 'local' });
			if (u.includes('/desired?revision=r1')) return new Response(null, { status: 204 });
			if (u.endsWith('/desired')) return Response.json(desiredState());
			if (u.endsWith('/report')) return new Response(null, { status: 204 });
			return Response.json(
				{ error: { code: 'unauthenticated', message: 'Unknown agent token' } },
				{ status: 401 }
			);
		});
		const cp = new ControlPlane('http://cp.test/', 'tok', fetch);

		expect(await cp.hello({} as AgentHello)).toEqual({ nodeId: 'node_1', name: 'local' });
		expect(await cp.desired(null)).toMatchObject({ revision: desiredState().revision });
		expect(await cp.desired('r1')).toBeNull();
		await cp.report({ containers: [], revision: null });
		await expect(cp.logs([])).rejects.toMatchObject({
			status: 401,
			message: 'Unknown agent token'
		});

		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe('http://cp.test/api/agent/v1/hello');
		expect(init?.headers).toMatchObject({
			authorization: 'Bearer tok',
			'content-type': 'application/json'
		});
	});
});
