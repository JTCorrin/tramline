import { db } from '#lib/server/db/index.js';
import { readLogs } from '#lib/server/nodes/logs.js';
import { ensureLocalNode } from '#lib/server/nodes/registry.js';
import { settings } from '#lib/server/settings.server.js';
import { seedCtx } from '#lib/server/testing.js';
import type { RequestEvent } from '@sveltejs/kit';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as deployRoute from '../../v1/environments/[id]/deploy/+server';
import * as environmentsRoute from '../../v1/environments/+server';
import * as deploymentRoute from '../../v1/deployments/[id]/+server';
import * as logsStream from '../../v1/deployments/[id]/logs/+server';
import * as redeployRoute from '../../v1/deployments/[id]/redeploy/+server';
import * as removeRoute from '../../v1/deployments/[id]/remove/+server';
import * as nodesRoute from '../../v1/nodes/+server';
import * as projectsRoute from '../../v1/projects/+server';
import * as servicesRoute from '../../v1/services/+server';
import * as desiredRoute from './desired/+server';
import * as helloRoute from './hello/+server';
import * as logsRoute from './logs/+server';
import * as reportRoute from './report/+server';

type Handler = (event: never) => Response | Promise<Response>;

async function call(
	handler: Handler,
	options: {
		path: string;
		method?: string;
		body?: unknown;
		params?: Record<string, string>;
		token?: string;
		user?: ReturnType<typeof seedCtx>;
		signal?: AbortSignal;
	}
) {
	const url = new URL(`http://localhost${options.path}`);
	const request = new Request(url, {
		method: options.method ?? 'GET',
		signal: options.signal,
		headers: {
			'content-type': 'application/json',
			...(options.token ? { authorization: `Bearer ${options.token}` } : {})
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body)
	});
	const locals = options.user
		? {
				user: { id: options.user.userId },
				session: { activeOrganizationId: options.user.organizationId }
			}
		: { user: null, session: null };
	const response = await handler({
		request,
		url,
		params: options.params ?? {},
		locals
	} as unknown as RequestEvent as never);
	const json = response.headers.get('content-type')?.includes('json')
		? await response.json()
		: null;
	return { status: response.status, body: json, response };
}

const hello = {
	protocol: 1,
	agentVersion: 'test',
	hostname: 'box',
	os: 'linux',
	arch: 'arm64',
	cpus: 2,
	memoryMb: 2048,
	docker: { version: '27.0.0' }
};

/** A user with a deployed whoami service and an online local node. */
async function deployed() {
	const user = seedCtx(db);
	const { node, tokenFile } = ensureLocalNode(db, settings.dataDir);
	const token = readFileSync(tokenFile, 'utf8').trim();
	await call(helloRoute.POST as Handler, {
		path: '/api/agent/v1/hello',
		method: 'POST',
		body: hello,
		token
	});

	const project = (
		await call(projectsRoute.POST as Handler, {
			path: '/api/v1/projects',
			method: 'POST',
			body: { name: 'Live' },
			user
		})
	).body;
	const [env] = (
		await call(environmentsRoute.GET as Handler, {
			path: `/api/v1/environments?projectId=${project.id}`,
			user
		})
	).body;
	await call(servicesRoute.POST as Handler, {
		path: '/api/v1/services',
		method: 'POST',
		user,
		body: {
			projectId: project.id,
			kind: 'image',
			source: { type: 'image', image: 'traefik/whoami' }
		}
	});
	const [dep] = (
		await call(deployRoute.POST as Handler, {
			path: `/api/v1/environments/${env.id}/deploy`,
			method: 'POST',
			params: { id: env.id },
			user
		})
	).body;
	// the agent's next report triggers a reconcile, which schedules the deployment onto this node
	await call(reportRoute.POST as Handler, {
		path: '/api/agent/v1/report',
		method: 'POST',
		token,
		body: { revision: null, containers: [] }
	});
	return { user, node, token, dep };
}

describe('agent API', () => {
	it('rejects unknown tokens', async () => {
		const res = await call(helloRoute.POST as Handler, {
			path: '/api/agent/v1/hello',
			method: 'POST',
			body: hello,
			token: 'nope'
		});
		expect(res).toMatchObject({ status: 401, body: { error: { message: 'Unknown agent token' } } });
		expect(
			(await call(desiredRoute.GET as Handler, { path: '/api/agent/v1/desired' })).status
		).toBe(401);
	});

	it('serves desired state, accepts reports and drives the deployment live', async () => {
		const { user, token, dep } = await deployed();

		const desired = await call(desiredRoute.GET as Handler, {
			path: '/api/agent/v1/desired',
			token
		});
		expect(desired.status).toBe(200);
		const mine = desired.body.containers.filter(
			(c: { deploymentId: string }) => c.deploymentId === dep.id
		);
		expect(mine).toHaveLength(1);

		const reported = await call(reportRoute.POST as Handler, {
			path: '/api/agent/v1/report',
			method: 'POST',
			token,
			body: {
				revision: desired.body.revision,
				containers: [
					{
						name: mine[0].name,
						deploymentId: dep.id,
						replica: 0,
						state: 'running',
						healthy: null,
						exitCode: null,
						restartCount: 0,
						error: null,
						startedAt: new Date(Date.now() - 60_000).toISOString()
					}
				]
			}
		});
		expect(reported.status).toBe(204);
		expect(
			(
				await call(deploymentRoute.GET as Handler, {
					path: `/api/v1/deployments/${dep.id}`,
					params: { id: dep.id },
					user
				})
			).body.status
		).toBe('active');

		const nodes = (await call(nodesRoute.GET as Handler, { path: '/api/v1/nodes', user })).body;
		expect(nodes).toEqual([
			expect.objectContaining({
				name: 'local',
				status: 'online',
				dockerVersion: '27.0.0',
				hostname: 'box'
			})
		]);
	});

	it('long-polls until the desired state changes', async () => {
		const { user, token, dep } = await deployed();
		const { body: current } = await call(desiredRoute.GET as Handler, {
			path: '/api/agent/v1/desired',
			token
		});

		const started = Date.now();
		const pending = call(desiredRoute.GET as Handler, {
			path: `/api/agent/v1/desired?revision=${current.revision}`,
			token
		});
		await new Promise((r) => setTimeout(r, 50));
		await call(removeRoute.POST as Handler, {
			path: `/api/v1/deployments/${dep.id}/remove`,
			method: 'POST',
			params: { id: dep.id },
			user
		});
		const next = await pending;
		expect(next.status).toBe(200);
		expect(next.body.revision).not.toBe(current.revision);
		expect(Date.now() - started).toBeLessThan(5_000);

		// an aborted long-poll returns without waiting for the timeout
		const abort = new AbortController();
		const idle = call(desiredRoute.GET as Handler, {
			path: `/api/agent/v1/desired?revision=${next.body.revision}`,
			token,
			signal: abort.signal
		});
		abort.abort();
		expect((await idle).status).toBe(204);
	});

	it('stores logs only for deployments on the reporting node and streams them', async () => {
		const { user, token, dep } = await deployed();

		const lines = [
			{
				deploymentId: dep.id,
				ts: '2026-10-23T10:00:00.000Z',
				stream: 'stdout',
				line: 'listening on :80'
			},
			{
				deploymentId: dep.id,
				ts: '2026-10-23T10:00:00.000Z',
				stream: 'system',
				line: 'forged system line'
			},
			{
				deploymentId: 'dep_someone_else',
				ts: '2026-10-23T10:00:00.000Z',
				stream: 'stdout',
				line: 'nope'
			}
		];
		expect(
			(
				await call(logsRoute.POST as Handler, {
					path: '/api/agent/v1/logs',
					method: 'POST',
					token,
					body: { lines }
				})
			).status
		).toBe(204);
		const stored = readLogs(settings.dataDir, dep.id).map((l) => l.line);
		expect(stored).toContain('listening on :80');
		expect(stored).not.toContain('forged system line');
		expect(readLogs(settings.dataDir, 'dep_someone_else')).toEqual([]);

		const abort = new AbortController();
		const { response } = await call(logsStream.GET as Handler, {
			path: `/api/v1/deployments/${dep.id}/logs`,
			params: { id: dep.id },
			user,
			signal: abort.signal
		});
		const reader = response.body!.getReader();
		let text = '';
		while (!text.includes('event: ready'))
			text += new TextDecoder().decode((await reader.read()).value);
		expect(text).toContain('listening on :80');
		abort.abort();

		expect(
			(
				await call(logsStream.GET as Handler, {
					path: `/api/v1/deployments/${dep.id}/logs`,
					params: { id: dep.id },
					user: seedCtx(db)
				})
			).status
		).toBe(404);
	});

	it('redeploys and removes through the API', async () => {
		const { user, dep } = await deployed();
		const copy = await call(redeployRoute.POST as Handler, {
			path: `/api/v1/deployments/${dep.id}/redeploy`,
			method: 'POST',
			params: { id: dep.id },
			user
		});
		expect(copy).toMatchObject({
			status: 201,
			body: { status: 'queued', source: 'traefik/whoami' }
		});
		expect(copy.body.id).not.toBe(dep.id);
		const removed = await call(removeRoute.POST as Handler, {
			path: `/api/v1/deployments/${copy.body.id}/remove`,
			method: 'POST',
			params: { id: copy.body.id },
			user
		});
		expect(removed.body.status).toBe('removed');
	});
});
