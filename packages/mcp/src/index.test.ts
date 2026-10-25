import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createClient } from '@tramline/client';
import { describe, expect, it } from 'vitest';
import { createTramlineServer, handleHttpRequest } from './index';

interface Seen {
	method: string;
	path: string;
	body: unknown;
	auth: string | null;
}

/** A Tramline API that records requests and answers from a table. */
function fakeApi(answers: Record<string, unknown> = {}) {
	const seen: Seen[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? 'GET';
		const path = url.pathname.replace(/^\/api\/v1/, '') + url.search;
		seen.push({
			method,
			path,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
			auth: new Headers(init?.headers).get('authorization')
		});
		const key = `${method} ${path}`;
		if (key in answers) {
			const answer = answers[key];
			if (answer instanceof Response) return answer;
			return answer === undefined ? new Response(null, { status: 204 }) : Response.json(answer);
		}
		return Response.json({ ok: true });
	};
	const client = createClient({ baseUrl: 'https://tramline.test/api/v1', token: 'tl_test', fetch });
	return { client, seen };
}

async function connect(answers?: Record<string, unknown>) {
	const api = fakeApi(answers);
	const [a, b] = InMemoryTransport.createLinkedPair();
	await createTramlineServer(api.client).connect(a);
	const mcp = new Client({ name: 'test', version: '1' });
	await mcp.connect(b);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = (await mcp.callTool({ name, arguments: args })) as {
			content: { text: string }[];
			isError?: boolean;
		};
		return { ...result, text: result.content[0]!.text };
	};
	return { ...api, mcp, call };
}

describe('Tramline MCP server', () => {
	it('offers the tools, marking deploy and discard destructive and reads read-only', async () => {
		const { mcp } = await connect();
		const { tools } = await mcp.listTools();
		const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
		expect(Object.keys(byName).sort()).toEqual([
			'create_environment',
			'create_service',
			'deploy',
			'discard_changes',
			'get_canvas',
			'get_deployment_logs',
			'get_staged_changes',
			'list_deployments',
			'list_environments',
			'list_projects',
			'set_variables',
			'update_service_config'
		]);
		expect(byName.deploy!.annotations).toMatchObject({ destructiveHint: true });
		expect(byName.discard_changes!.annotations).toMatchObject({ destructiveHint: true });
		expect(byName.list_projects!.annotations).toMatchObject({ readOnlyHint: true });
		expect(mcp.getInstructions()).toContain('Changes are staged first');
	});

	it.each([
		['list_projects', {}, 'GET', '/projects', undefined],
		[
			'list_environments',
			{ projectId: 'prj_1' },
			'GET',
			'/environments?projectId=prj_1',
			undefined
		],
		[
			'create_environment',
			{ projectId: 'prj_1', name: 'staging', copyFrom: 'env_1' },
			'POST',
			'/environments',
			{ projectId: 'prj_1', name: 'staging', copyFrom: 'env_1' }
		],
		['get_canvas', { environmentId: 'env_1' }, 'GET', '/environments/env_1/canvas', undefined],
		[
			'create_service',
			{ projectId: 'prj_1', kind: 'database', engine: 'postgres' },
			'POST',
			'/services',
			{ projectId: 'prj_1', kind: 'database', engine: 'postgres' }
		],
		[
			'create_service',
			{ projectId: 'prj_1', kind: 'image', image: 'traefik/whoami' },
			'POST',
			'/services',
			{ projectId: 'prj_1', kind: 'image', source: { type: 'image', image: 'traefik/whoami' } }
		],
		[
			'create_service',
			{ projectId: 'prj_1', kind: 'repo', repo: 'https://github.com/acme/api' },
			'POST',
			'/services',
			{
				projectId: 'prj_1',
				kind: 'repo',
				source: {
					type: 'repo',
					repo: 'https://github.com/acme/api',
					branch: 'main',
					rootDirectory: '/'
				}
			}
		],
		[
			'update_service_config',
			{ serviceId: 'svc_1', environmentId: 'env_1', patch: { networking: { port: 3000 } } },
			'PATCH',
			'/services/svc_1/config?environmentId=env_1',
			{ networking: { port: 3000 } }
		],
		[
			'set_variables',
			{
				environmentId: 'env_1',
				serviceId: 'svc_1',
				set: { DATABASE_URL: '${{Postgres.DATABASE_URL}}' }
			},
			'PATCH',
			'/variables',
			{
				environmentId: 'env_1',
				serviceId: 'svc_1',
				set: { DATABASE_URL: '${{Postgres.DATABASE_URL}}' },
				unset: []
			}
		],
		[
			'set_variables',
			{ environmentId: 'env_1', unset: ['OLD'] },
			'PATCH',
			'/variables',
			{ environmentId: 'env_1', serviceId: null, set: {}, unset: ['OLD'] }
		],
		[
			'get_staged_changes',
			{ environmentId: 'env_1' },
			'GET',
			'/environments/env_1/changes',
			undefined
		],
		['deploy', { environmentId: 'env_1' }, 'POST', '/environments/env_1/deploy', {}],
		[
			'discard_changes',
			{ environmentId: 'env_1' },
			'DELETE',
			'/environments/env_1/changes',
			undefined
		],
		[
			'list_deployments',
			{ serviceId: 'svc_1', environmentId: 'env_1' },
			'GET',
			'/deployments?serviceId=svc_1&environmentId=env_1',
			undefined
		]
	])('%s calls the API', async (tool, args, method, path, body) => {
		const { call, seen } = await connect();
		const result = await call(tool, args);
		expect(result.isError).toBeFalsy();
		expect(seen).toEqual([{ method, path, body, auth: 'Bearer tl_test' }]);
	});

	it('reads deployment logs as lines', async () => {
		const lines = [
			{ deploymentId: 'dep_1', ts: '2026-10-25T10:00:00.000Z', stream: 'system', line: 'Queued' },
			{ deploymentId: 'dep_1', ts: '2026-10-25T10:00:01.000Z', stream: 'stdout', line: 'listening' }
		];
		const { call, seen } = await connect({
			'GET /deployments/dep_1/logs?format=json&tail=50': lines
		});
		const result = await call('get_deployment_logs', { deploymentId: 'dep_1', tail: 50 });
		expect(JSON.parse(result.text)).toEqual([
			'2026-10-25T10:00:00.000Z [system] Queued',
			'2026-10-25T10:00:01.000Z [stdout] listening'
		]);
		expect(seen[0]!.path).toBe('/deployments/dep_1/logs?format=json&tail=50');
	});

	it('returns API errors as tool errors the model can act on', async () => {
		const { call } = await connect({
			'POST /environments/env_1/deploy': Response.json(
				{ error: { code: 'forbidden', message: 'This token needs the deploy scope' } },
				{ status: 403 }
			),
			'POST /services': Response.json(
				{
					error: {
						code: 'validation_failed',
						message: 'Invalid input',
						issues: [{ path: 'name', message: 'Too long' }]
					}
				},
				{ status: 422 }
			)
		});
		expect(await call('deploy', { environmentId: 'env_1' })).toMatchObject({
			isError: true,
			text: 'This token needs the deploy scope'
		});
		const invalid = await call('create_service', { projectId: 'prj_1', kind: 'image', image: 'x' });
		expect(invalid.isError).toBe(true);
		expect(invalid.text).toContain('Invalid input: [{"path":"name","message":"Too long"}]');
	});

	it('reports network failures, and leaves out a source it was not given', async () => {
		const offline = createClient({
			baseUrl: 'https://tramline.test/api/v1',
			token: 'tl_test',
			fetch: async () => {
				throw new Error('connect ECONNREFUSED');
			}
		});
		const strange = createClient({
			baseUrl: 'https://tramline.test/api/v1',
			token: 'tl_test',
			fetch: async () => {
				throw 'something odd';
			}
		});
		for (const [client, message] of [
			[offline, 'connect ECONNREFUSED'],
			[strange, 'something odd']
		] as const) {
			const [a, b] = InMemoryTransport.createLinkedPair();
			await createTramlineServer(client).connect(a);
			const mcp = new Client({ name: 'test', version: '1' });
			await mcp.connect(b);
			const result = (await mcp.callTool({ name: 'list_projects', arguments: {} })) as {
				content: { text: string }[];
				isError: boolean;
			};
			expect(result).toMatchObject({ isError: true, content: [{ text: message }] });
		}

		const { call, seen } = await connect();
		await call('create_service', { projectId: 'prj_1', kind: 'image' });
		expect(seen[0]!.body).toEqual({ projectId: 'prj_1', kind: 'image' });
		await call('get_deployment_logs', { deploymentId: 'dep_1' });
		expect(seen[1]!.path).toBe('/deployments/dep_1/logs?format=json&tail=200');
	});

	it('serves the canvas and logs as resources, and a prompt', async () => {
		const { mcp } = await connect({
			'GET /environments/env_1/canvas': { environmentId: 'env_1', services: [], edges: [] },
			'GET /deployments/dep_1/logs?format=json&tail=200': [
				{ deploymentId: 'dep_1', ts: 't', stream: 'stdout', line: 'hi' }
			]
		});
		const canvas = await mcp.readResource({ uri: 'tramline://environment/env_1/canvas' });
		expect(JSON.parse((canvas.contents[0] as { text: string }).text)).toEqual({
			environmentId: 'env_1',
			services: [],
			edges: []
		});
		const logs = await mcp.readResource({ uri: 'tramline://deployment/dep_1/logs' });
		expect((logs.contents[0] as { text: string }).text).toBe('t [stdout] hi');

		const prompt = await mcp.getPrompt({
			name: 'deploy_repo_with_postgres',
			arguments: { projectId: 'prj_1', repo: 'https://github.com/acme/api' }
		});
		expect(JSON.stringify(prompt.messages)).toContain('${{Postgres.DATABASE_URL}}');
	});

	it('answers Streamable HTTP requests statelessly', async () => {
		const { client } = fakeApi();
		const response = await handleHttpRequest(
			new Request('https://tramline.test/mcp', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream'
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: {
						protocolVersion: '2025-06-18',
						capabilities: {},
						clientInfo: { name: 'test', version: '1' }
					}
				})
			}),
			client
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { result: { serverInfo: { name: string } } };
		expect(body.result.serverInfo.name).toBe('tramline');
	});
});
