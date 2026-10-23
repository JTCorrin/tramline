import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Agent } from './agent';
import { ControlPlane } from './client';
import { DockerRuntime } from './docker';

const VERSION = '0.1.0';

const tokenFile =
	process.env.TRAMLINE_AGENT_TOKEN_FILE ?? path.resolve('../web/data/local-agent.token');

/** The token comes from the environment, or from a file the control plane writes on first boot. */
async function token() {
	if (process.env.TRAMLINE_AGENT_TOKEN) return process.env.TRAMLINE_AGENT_TOKEN.trim();
	for (let waited = 0; ; waited++) {
		try {
			return readFileSync(tokenFile, 'utf8').trim();
		} catch {
			if (waited === 0) console.log(`[agent] waiting for a token at ${tokenFile}`);
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
	}
}

const client = new ControlPlane(process.env.TRAMLINE_URL ?? 'http://localhost:5173', await token());

const agent = new Agent({
	runtime: new DockerRuntime(),
	client,
	// the control plane rewrites the file when it rotates the local node's token
	onUnauthorized: () => {
		if (process.env.TRAMLINE_AGENT_TOKEN) return;
		try {
			client.token = readFileSync(tokenFile, 'utf8').trim();
		} catch {
			// keep the old token; the next attempt will say so again
		}
	},
	stateDir: process.env.TRAMLINE_AGENT_STATE_DIR ?? path.join(os.homedir(), '.tramline', 'agent'),
	version: VERSION
});

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
