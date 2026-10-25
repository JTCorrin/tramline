import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ApiError, type TramlineClient } from '@tramline/client';
import { DATABASE_ENGINES, ServiceConfigPatch } from '@tramline/contracts';
import { z } from 'zod';

export const SERVER_NAME = 'tramline';

const INSTRUCTIONS = `Tramline deploys services onto your own infrastructure, like Railway.
A project has environments (e.g. production); each has services drawn on a canvas.
Changes are staged first: create services, update config and set variables, then
call get_staged_changes to review and deploy to apply them. Reference another
service's variables with \${{Service.KEY}} (e.g. \${{Postgres.DATABASE_URL}}).`;

/** A tool's JSON result, as MCP text content. */
const json = (value: unknown) => ({
	content: [{ type: 'text' as const, text: JSON.stringify(value ?? null, null, 2) }]
});

/** API errors become tool errors the model can read and act on. */
async function run(fn: () => Promise<unknown>) {
	try {
		return json(await fn());
	} catch (error) {
		const message =
			error instanceof ApiError
				? `${error.message}${error.issues ? `: ${JSON.stringify(error.issues)}` : ''}`
				: error instanceof Error
					? error.message
					: String(error);
		return { content: [{ type: 'text' as const, text: message }], isError: true };
	}
}

/**
 * The Tramline MCP server. Every tool goes through the public API client, so
 * an agent can do exactly what its API token allows and nothing more: a
 * token without the `deploy` scope can only stage changes.
 */
export function createTramlineServer(client: TramlineClient, version = '0.1.0') {
	const server = new McpServer({ name: SERVER_NAME, version }, { instructions: INSTRUCTIONS });
	const readOnly = { readOnlyHint: true, openWorldHint: false };

	server.registerTool(
		'list_projects',
		{ description: 'List the projects in the organization.', annotations: readOnly },
		() => run(() => client.projects.getAll())
	);

	server.registerTool(
		'list_nodes',
		{
			description:
				"List the machines services run on: status, capacity, and whether they are cordoned. Pin a service to one with update_service_config's deploy.node.",
			annotations: readOnly
		},
		() => run(() => client.nodes.getAll())
	);

	server.registerTool(
		'list_environments',
		{
			description:
				"List a project's environments (each has its own services' config and variables).",
			inputSchema: { projectId: z.string() },
			annotations: readOnly
		},
		({ projectId }) => run(() => client.environments.getAll({ projectId }))
	);

	server.registerTool(
		'create_environment',
		{
			description:
				'Create an environment with every service. copyFrom duplicates an environment, variables included (databases get new credentials).',
			inputSchema: {
				projectId: z.string(),
				name: z.string(),
				copyFrom: z.string().optional().describe('An environment id to duplicate')
			}
		},
		(input) => run(() => client.environments.create(input))
	);

	server.registerTool(
		'get_canvas',
		{
			description:
				"An environment's services (status, source, URL, staged changes) and the references between them.",
			inputSchema: { environmentId: z.string() },
			annotations: readOnly
		},
		({ environmentId }) => run(() => client.environments.canvas(environmentId))
	);

	server.registerTool(
		'create_service',
		{
			description:
				'Add a service to a project (in every environment, staged until deployed): a Docker image, a Git repository, or a database (postgres, mysql, redis, mongo) with generated credentials and a volume.',
			inputSchema: {
				projectId: z.string(),
				kind: z.enum(['image', 'repo', 'database']),
				name: z.string().optional(),
				image: z.string().optional().describe('For kind image, e.g. traefik/whoami'),
				repo: z.string().optional().describe('For kind repo, an https Git URL'),
				branch: z.string().optional().describe('For kind repo (default main)'),
				rootDirectory: z.string().optional().describe('For kind repo (default /)'),
				engine: z.enum(DATABASE_ENGINES).optional().describe('For kind database')
			}
		},
		(input) =>
			run(() =>
				client.services.create({
					projectId: input.projectId,
					kind: input.kind,
					name: input.name,
					engine: input.engine,
					source:
						input.kind === 'image' && input.image
							? { type: 'image', image: input.image }
							: input.kind === 'repo' && input.repo
								? {
										type: 'repo',
										repo: input.repo,
										branch: input.branch ?? 'main',
										rootDirectory: input.rootDirectory ?? '/'
									}
								: undefined
				})
			)
	);

	server.registerTool(
		'update_service_config',
		{
			description:
				"Stage a change to a service's config in one environment: source, build (builder, scan, watchPaths), deploy (startCommand, replicas, healthcheckPath, restartPolicy, cronSchedule, memoryMb), networking (port, publicDomain) or volume (mountPath). Sections merge.",
			inputSchema: {
				serviceId: z.string(),
				environmentId: z.string(),
				patch: ServiceConfigPatch
			}
		},
		({ serviceId, environmentId, patch }) =>
			run(() => client.services.stageConfig(serviceId, environmentId, patch))
	);

	server.registerTool(
		'set_variables',
		{
			description:
				"Stage variables for a service (or the environment's shared variables when serviceId is omitted). Values may reference ${{Service.KEY}}.",
			inputSchema: {
				environmentId: z.string(),
				serviceId: z.string().optional(),
				set: z.record(z.string(), z.string()).optional(),
				unset: z.array(z.string()).optional()
			}
		},
		(input) =>
			run(() =>
				client.variables.stage({
					environmentId: input.environmentId,
					serviceId: input.serviceId ?? null,
					set: input.set ?? {},
					unset: input.unset ?? []
				})
			)
	);

	server.registerTool(
		'get_staged_changes',
		{
			description: 'The changes in an environment that the next deploy will apply.',
			inputSchema: { environmentId: z.string() },
			annotations: readOnly
		},
		({ environmentId }) => run(() => client.environments.changes(environmentId))
	);

	server.registerTool(
		'deploy',
		{
			description:
				"Apply an environment's staged changes and deploy the affected services. Needs a token with the deploy scope.",
			inputSchema: { environmentId: z.string() },
			annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
		},
		({ environmentId }) => run(() => client.environments.deploy(environmentId))
	);

	server.registerTool(
		'discard_changes',
		{
			description:
				"Throw away an environment's staged changes (services never deployed are removed).",
			inputSchema: { environmentId: z.string() },
			annotations: { destructiveHint: true, openWorldHint: false }
		},
		({ environmentId }) => run(() => client.environments.discard(environmentId))
	);

	server.registerTool(
		'list_deployments',
		{
			description:
				"A service's deployments in an environment, newest first, with status and message.",
			inputSchema: { serviceId: z.string(), environmentId: z.string() },
			annotations: readOnly
		},
		(query) => run(() => client.deployments.getAll(query))
	);

	server.registerTool(
		'get_deployment_logs',
		{
			description:
				"The last lines of a deployment's log: build output, system events and the app's output.",
			inputSchema: {
				deploymentId: z.string(),
				tail: z.number().int().min(1).max(1000).optional()
			},
			annotations: readOnly
		},
		({ deploymentId, tail }) =>
			run(async () =>
				(await client.deployments.logs(deploymentId, tail ?? 200)).map(
					(l) => `${l.ts} [${l.stream}] ${l.line}`
				)
			)
	);

	server.registerResource(
		'canvas',
		new ResourceTemplate('tramline://environment/{environmentId}/canvas', { list: undefined }),
		{ description: "An environment's services and references", mimeType: 'application/json' },
		async (uri, { environmentId }) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: 'application/json',
					text: JSON.stringify(await client.environments.canvas(String(environmentId)), null, 2)
				}
			]
		})
	);

	server.registerResource(
		'deployment-logs',
		new ResourceTemplate('tramline://deployment/{deploymentId}/logs', { list: undefined }),
		{ description: "A deployment's last 200 log lines", mimeType: 'text/plain' },
		async (uri, { deploymentId }) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: 'text/plain',
					text: (await client.deployments.logs(String(deploymentId)))
						.map((l) => `${l.ts} [${l.stream}] ${l.line}`)
						.join('\n')
				}
			]
		})
	);

	server.registerPrompt(
		'deploy_repo_with_postgres',
		{
			description: 'Deploy a Git repository with a Postgres database wired to it.',
			argsSchema: { projectId: z.string(), repo: z.string() }
		},
		({ projectId, repo }) => ({
			messages: [
				{
					role: 'user',
					content: {
						type: 'text',
						text: `In Tramline project ${projectId}: add a Postgres database and a service built from ${repo}. Set the app's DATABASE_URL to \${{Postgres.DATABASE_URL}}, give it a port and a public domain, review the staged changes, deploy, and check the deployment logs until it is live.`
					}
				}
			]
		})
	);

	return server;
}

/**
 * Answers one Streamable HTTP request statelessly: a fresh server per
 * request, acting with `client` (which carries the caller's token).
 */
export async function handleHttpRequest(request: Request, client: TramlineClient) {
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true
	});
	await createTramlineServer(client).connect(transport);
	return transport.handleRequest(request);
}
