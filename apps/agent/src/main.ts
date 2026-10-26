import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Agent } from './agent';
import { ControlPlane } from './client';
import { DockerRuntime } from './docker';
import { enroll, nodeTokenFile } from './enroll';
import { DEFAULT_MESH_IMAGE } from './mesh';

const VERSION = '0.1.0';

// TCP proxies run this same program in proxy mode
if (process.argv[2] === 'proxy') {
	const { runTcpProxy } = await import('./tcp-proxy');
	await runTcpProxy(JSON.parse(process.argv[3]!));
	await new Promise(() => {});
}

// the mesh container runs this same program in mesh mode
if (process.argv[2] === 'mesh') {
	const { runMeshDaemon } = await import('./mesh-daemon');
	const { MESH_CONFIG_PATH } = await import('./mesh');
	await runMeshDaemon(MESH_CONFIG_PATH);
}

const url = process.env.TRAMLINE_URL ?? 'http://localhost:5173';
const stateDir =
	process.env.TRAMLINE_AGENT_STATE_DIR ?? path.join(os.homedir(), '.tramline', 'agent');
const localTokenFile =
	process.env.TRAMLINE_AGENT_TOKEN_FILE ?? path.resolve('../web/data/local-agent.token');

/**
 * The token comes from the environment; from enrolling with a join token (or
 * the node token saved when it did); or, for the agent next to the control
 * plane, from a file the control plane writes on first boot.
 */
async function token(agent: Agent) {
	if (process.env.TRAMLINE_AGENT_TOKEN) return process.env.TRAMLINE_AGENT_TOKEN.trim();
	if (process.env.TRAMLINE_JOIN_TOKEN || existsSync(nodeTokenFile(stateDir))) {
		return enroll({
			url,
			joinToken: process.env.TRAMLINE_JOIN_TOKEN ?? '',
			stateDir,
			describe: () => agent.describe()
		});
	}
	for (let waited = 0; ; waited++) {
		try {
			return readFileSync(localTokenFile, 'utf8').trim();
		} catch {
			if (waited === 0) console.log(`[agent] waiting for a token at ${localTokenFile}`);
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
	}
}

const client = new ControlPlane(url, '');

const agent = new Agent({
	runtime: new DockerRuntime(),
	client,
	onUnauthorized: () => {
		if (process.env.TRAMLINE_AGENT_TOKEN) return;
		if (existsSync(nodeTokenFile(stateDir))) {
			console.log('[agent] Tramline no longer knows this node; was it removed?');
			return;
		}
		// the control plane rewrites the file when it rotates the local node's token
		try {
			client.token = readFileSync(localTokenFile, 'utf8').trim();
		} catch {
			// keep the old token; the next attempt will say so again
		}
	},
	stateDir,
	version: VERSION,
	// TRAMLINE_MESH=off for an agent that should never run the mesh container
	mesh:
		process.env.TRAMLINE_MESH === 'off'
			? undefined
			: {
					image: process.env.TRAMLINE_MESH_IMAGE ?? DEFAULT_MESH_IMAGE,
					endpoint: process.env.TRAMLINE_MESH_ENDPOINT || null
				}
});

try {
	client.token = await token(agent);
} catch (error) {
	console.error(`[agent] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

// liveness probe for supervisors and the e2e harness
const health = createServer((_, res) => {
	res.setHeader('content-type', 'application/json');
	res.end(
		JSON.stringify({
			ok: !agent.stopped,
			revision: agent.desired?.revision ?? null,
			dockerError: agent.dockerError
		})
	);
});
health.listen(Number(process.env.TRAMLINE_AGENT_HEALTH_PORT ?? 7171), '127.0.0.1');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		agent.stop();
		health.close();
		process.exit(0);
	});
}

console.log(`[agent] tramline agent ${VERSION} starting`);
await agent.start();
