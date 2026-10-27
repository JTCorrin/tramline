import type { AgentHello, AgentReport, DesiredState, LogLine } from '@tramline/contracts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gzipSync } from 'node:zlib';
import { Agent } from './agent';
import { encrypt } from './backups';
import { ControlPlane, ControlPlaneError } from './client';
import { RAILPACK } from './pins';
import { desiredState, FakeRuntime, fakeTools, stateDirWithTools } from './testing';

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

	it('keeps going when its token is rejected, asking for a fresh token first', async () => {
		const runtime = new FakeRuntime();
		const { client } = fakeClient();
		client.desired
			.mockRejectedValueOnce(new ControlPlaneError(401, 'Unknown agent token'))
			.mockResolvedValue(null);
		const onUnauthorized = vi.fn();
		const agent = new Agent({
			runtime,
			client,
			stateDir: mkdtempSync(path.join(tmpdir(), 'tramline-agent-')),
			version: 'test',
			reportIntervalMs: 10,
			unauthorizedBackoffMs: 10,
			onUnauthorized,
			log: () => {}
		});
		await agent.start();
		await vi.waitFor(() => expect(client.desired.mock.calls.length).toBeGreaterThan(2));
		expect(onUnauthorized).toHaveBeenCalledOnce();
		expect(agent.stopped).toBe(false);
		agent.stop();
		expect(agent.stopped).toBe(true);
	});
});

describe('Agent builds', () => {
	const build = (deploymentId: string) => ({
		deploymentId,
		serviceId: 'svc_1',
		organizationId: 'org_1',
		repo: 'https://github.com/acme/api',
		ref: 'main',
		commit: null,
		token: null,
		rootDirectory: '/',
		builder: 'railpack' as const,
		dockerfilePath: null,
		buildCommand: null,
		startCommand: null,
		image: `tramline/svc_1:${deploymentId}`,
		secrets: {},
		scan: 'off' as const
	});

	function setup(desired: DesiredState[]) {
		const runtime = new FakeRuntime();
		const stateDir = stateDirWithTools();
		runtime.onExec = (cmd, { onLine }) => {
			if (cmd[0] === 'sh') onLine('stdout', 'c'.repeat(40));
			if (cmd[0] === 'test') return 1;
			if (cmd[0] === 'buildctl' && cmd[1] === 'build') {
				const name = cmd.at(-1)!.replace('type=docker,name=', '');
				runtime.images.set(name, { id: `sha256:${name.split(':')[1]}`, created: Date.now() });
			}
			return 0;
		};
		const { client, calls } = fakeClient(desired);
		const agent = new Agent({
			runtime,
			client,
			stateDir,
			version: 'test',
			tools: fakeTools,
			log: () => {}
		});
		return { agent, runtime, calls };
	}

	it('builds what the control plane asks for and reports the result', async () => {
		const withBuild = { ...desiredState([]), revision: 'b1', builds: [build('dep_7')] };
		const { agent, calls } = setup([withBuild, { ...desiredState([]), revision: 'b2' }]);
		await agent.hello();
		await agent.sync();
		await vi.waitFor(() => expect(agent.builds.get('dep_7')?.state).toBe('succeeded'));
		await agent.tick();
		expect(calls.reports.at(-1)!.builds).toEqual([
			{
				deploymentId: 'dep_7',
				state: 'succeeded',
				image: 'sha256:dep_7',
				commit: 'c'.repeat(40),
				error: null,
				scan: null
			}
		]);

		// once the control plane moves on, the agent forgets it
		await agent.sync();
		await agent.tick();
		expect(calls.reports.at(-1)!.builds).toEqual([]);
	});

	it('pulls and scans registry images in the build queue', async () => {
		const withScan = {
			...desiredState([]),
			revision: 's1',
			scans: [{ deploymentId: 'dep_9', image: 'traefik/whoami', scan: 'warn' as const }]
		};
		const { agent, runtime } = setup([withScan]);
		runtime.digests.set('traefik/whoami', 'traefik/whoami@sha256:abc');
		await agent.hello();
		await agent.sync();
		await vi.waitFor(() => expect(agent.builds.get('dep_9')?.state).toBe('succeeded'));
		expect(agent.builds.get('dep_9')?.image).toBe('traefik/whoami@sha256:abc');
	});

	it('runs backups and restores, holding containers during a volume restore', async () => {
		const key = Buffer.alloc(32, 7).toString('base64');
		const withJobs = {
			...desiredState([]),
			revision: 'j1',
			backups: [
				{
					id: 'bak_1',
					kind: 'volume' as const,
					container: null,
					volume: 'tl-vol_1',
					url: 'https://bucket.example/bak_1',
					key
				},
				// no presigned URL yet: fails rather than uploading anywhere
				{
					id: 'bak_2',
					kind: 'postgres' as const,
					container: 'tl-db-0',
					volume: 'v',
					url: null,
					key: null
				}
			],
			restores: [
				{
					id: 'rst_1',
					kind: 'volume' as const,
					container: null,
					stop: ['tl-dep_1-0'],
					volume: 'tl-vol_1',
					url: 'https://bucket.example/bak_0',
					key
				}
			]
		};
		const runtime = new FakeRuntime();
		const { client, calls } = fakeClient([withJobs, { ...desiredState([]), revision: 'j2' }]);
		const chunks: Buffer[] = [];
		await pipeline(Readable.from([gzipSync('tar')]), encrypt(key), async function* (source) {
			for await (const chunk of source) chunks.push(chunk as Buffer);
		});
		const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
			init?.method === 'PUT'
				? new Response(null, { status: 200 })
				: new Response(new Uint8Array(Buffer.concat(chunks)))
		);
		const agent = new Agent({
			runtime,
			client,
			stateDir: stateDirWithTools(),
			version: 'test',
			fetcher,
			tools: fakeTools,
			log: () => {}
		});
		await agent.hello();
		await agent.sync();
		await agent.tick();
		await vi.waitFor(() => expect(agent.jobs.restore.get('rst_1')?.state).toBe('succeeded'));
		expect(agent.jobs.backup.get('bak_1')?.state).toBe('succeeded');
		expect(agent.jobs.backup.get('bak_2')).toMatchObject({
			state: 'failed',
			error: 'No upload URL for this backup'
		});
		expect(runtime.calls).toContain('stop tl-dep_1-0 30');
		// released afterwards, so the next pass starts it again
		expect(agent.converger.held.size).toBe(0);
		await agent.tick();
		expect(calls.reports.at(-1)!.backups.map((b) => b.id)).toEqual(['bak_1', 'bak_2']);
		expect(calls.reports.at(-1)!.restores.map((r) => r.state)).toEqual(['succeeded']);

		// once the control plane moves on, they are forgotten
		await agent.sync();
		await agent.tick();
		expect(calls.reports.at(-1)!.backups).toEqual([]);
	});

	it('skips builds cancelled while waiting their turn', async () => {
		const both = { ...desiredState([]), revision: 'b1', builds: [build('dep_1'), build('dep_2')] };
		const onlyFirst = { ...desiredState([]), revision: 'b2', builds: [build('dep_1')] };
		const { agent, runtime } = setup([both, onlyFirst]);
		await agent.hello();
		await agent.sync();
		await agent.sync(); // dep_2 removed before its turn
		await vi.waitFor(() => expect(agent.builds.get('dep_1')?.state).toBe('succeeded'));
		await vi.waitFor(() => expect(agent.builds.has('dep_2')).toBe(false));
		expect(runtime.images.has('tramline/svc_1:dep_2')).toBe(false);
	});

	it('stops a running build the control plane no longer wants', async () => {
		const running = { ...desiredState([]), revision: 'b1', builds: [build('dep_9')] };
		const dropped = { ...desiredState([]), revision: 'b2' };
		const { agent, runtime } = setup([running, dropped]);
		let release!: () => void;
		const base = runtime.onExec!;
		runtime.onExec = (cmd, options) => {
			// a long build: it only finishes when the builder is removed
			if (cmd[0] === 'buildctl' && cmd[1] === 'build') {
				return new Promise<number>((resolve) => (release = () => resolve(137)));
			}
			return base(cmd, options);
		};
		const remove = runtime.remove.bind(runtime);
		runtime.remove = async (name) => {
			if (name === 'tl-build-dep_9') release?.();
			await remove(name);
		};
		await agent.hello();
		await agent.sync();
		await vi.waitFor(() => expect(release).toBeTypeOf('function'));
		await agent.sync(); // the control plane timed it out
		await vi.waitFor(() => expect(agent.builds.has('dep_9')).toBe(false));
		expect(runtime.containers.has('tl-build-dep_9')).toBe(false);
		expect(agent.queues.build.active).toEqual([]);
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
