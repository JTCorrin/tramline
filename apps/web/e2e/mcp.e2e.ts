import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { createProject, expect, signUp, test } from './helpers';

const BASE = 'http://localhost:4173';

/** Creates an API token in Settings, as a person would, and returns its secret. */
async function createToken(page: Page, name: string, scopes: ('write' | 'deploy')[]) {
	await page.goto('/settings');
	const card = page.getByTestId('api-tokens');
	await card.getByLabel('Name').fill(name);
	for (const scope of scopes) await card.getByRole('switch', { name: `Scope ${scope}` }).click();
	await card.getByRole('button', { name: 'Create token' }).click();
	const secret = await card.getByTestId('new-token').inputValue();
	expect(secret).toMatch(/^tl_/);
	await card.getByRole('button', { name: 'Done' }).click();
	await expect(card.getByTestId('token-list')).toContainText(name);
	return secret;
}

/** Calls a tool and parses its JSON, failing the test on a tool error. */
async function tool<T>(mcp: Client, name: string, args: Record<string, unknown> = {}) {
	const result = (await mcp.callTool({ name, arguments: args })) as {
		content: { text: string }[];
		isError?: boolean;
	};
	if (result.isError) throw new Error(`${name}: ${result.content[0]!.text}`);
	return JSON.parse(result.content[0]!.text) as T;
}

async function overHttp(token: string) {
	const mcp = new Client({ name: 'e2e', version: '1' });
	await mcp.connect(
		new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
			requestInit: { headers: { authorization: `Bearer ${token}` } }
		})
	);
	return mcp;
}

test('an agent adds Postgres and an app over MCP, wires DATABASE_URL and deploys', async ({
	page
}) => {
	await signUp(page);
	await createProject(page, 'Agents');
	const token = await createToken(page, 'claude', ['write', 'deploy']);

	const mcp = await overHttp(token);
	const [project] = await tool<{ id: string; name: string }[]>(mcp, 'list_projects');
	expect(project!.name).toBe('Agents');
	const [env] = await tool<{ id: string }[]>(mcp, 'list_environments', { projectId: project!.id });

	await tool(mcp, 'create_service', {
		projectId: project!.id,
		kind: 'database',
		engine: 'postgres'
	});
	const app = await tool<{ id: string }>(mcp, 'create_service', {
		projectId: project!.id,
		kind: 'image',
		image: 'traefik/whoami'
	});
	await tool(mcp, 'update_service_config', {
		serviceId: app.id,
		environmentId: env!.id,
		patch: { networking: { port: 80, publicDomain: true } }
	});
	await tool(mcp, 'set_variables', {
		environmentId: env!.id,
		serviceId: app.id,
		set: { DATABASE_URL: '${{Postgres.DATABASE_URL}}' }
	});

	const canvas = await tool<{ edges: unknown[] }>(mcp, 'get_canvas', { environmentId: env!.id });
	expect(canvas.edges).toHaveLength(1);
	const changes = await tool<{ count: number }>(mcp, 'get_staged_changes', {
		environmentId: env!.id
	});
	expect(changes.count).toBeGreaterThan(0);

	const deployed = await tool<{ id: string; serviceId: string }[]>(mcp, 'deploy', {
		environmentId: env!.id
	});
	expect(deployed).toHaveLength(2);
	const ours = deployed.find((d) => d.serviceId === app.id)!;
	const logs = await tool<string[]>(mcp, 'get_deployment_logs', { deploymentId: ours.id });
	expect(logs.join('\n')).toContain('Queued');

	// the person sees what the agent did, and who did it
	await page.goto('/settings');
	await expect(page.getByTestId('audit-log')).toContainText('via token “claude”');
	await expect(page.getByTestId('audit-log')).toContainText('POST environments/[id]/deploy');
	await mcp.close();
});

test('a token without the deploy scope can stage but not deploy, over stdio too', async ({
	page
}) => {
	await signUp(page, 'Stdio Org');
	await createProject(page, 'Staging only');
	const token = await createToken(page, 'stager', ['write']);

	// the stdio server, as `claude mcp add` would run it
	const mcp = new Client({ name: 'e2e', version: '1' });
	await mcp.connect(
		new StdioClientTransport({
			command: 'pnpm',
			args: ['--silent', 'start'],
			cwd: path.resolve(import.meta.dirname, '../../../packages/mcp'),
			env: { ...process.env, TRAMLINE_URL: BASE, TRAMLINE_TOKEN: token } as Record<string, string>
		})
	);
	const [project] = await tool<{ id: string }[]>(mcp, 'list_projects');
	const [env] = await tool<{ id: string }[]>(mcp, 'list_environments', { projectId: project!.id });
	await tool(mcp, 'create_service', {
		projectId: project!.id,
		kind: 'image',
		image: 'traefik/whoami'
	});

	const refused = (await mcp.callTool({
		name: 'deploy',
		arguments: { environmentId: env!.id }
	})) as { content: { text: string }[]; isError: boolean };
	expect(refused).toMatchObject({
		isError: true,
		content: [{ text: 'This token needs the deploy scope' }]
	});
	await mcp.close();
});

test('/mcp needs an API token', async ({ request }) => {
	const response = await request.post(`${BASE}/mcp`, { data: {} });
	expect(response.status()).toBe(401);
	expect(response.headers()['www-authenticate']).toBe('Bearer');
});
