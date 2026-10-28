import { AgentJoined, type AgentHello } from '@tramline/contracts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ControlPlaneError } from './client';

export interface EnrollOptions {
	url: string;
	/** The one-time join token from "Add node". */
	joinToken: string;
	stateDir: string;
	describe: () => Promise<AgentHello>;
	fetcher?: typeof fetch;
	log?: (message: string) => void;
	/** Delay between attempts while the control plane is unreachable. */
	retryMs?: number;
}

/** Where an enrolled node keeps its token (mode 600). */
export const nodeTokenFile = (stateDir: string) => path.join(stateDir, 'node.token');

/**
 * Returns this machine's node token, joining first if it has none. A join
 * token works once, so the node token is saved before anything else happens;
 * restarts reuse it. A refused join token is final: retrying can't fix it.
 */
export async function enroll(options: EnrollOptions): Promise<string> {
	const file = nodeTokenFile(options.stateDir);
	try {
		return readFileSync(file, 'utf8').trim();
	} catch {
		// not enrolled yet
	}

	const fetcher = options.fetcher ?? globalThis.fetch;
	const log = options.log ?? console.log;
	for (;;) {
		try {
			const response = await fetcher(`${options.url.replace(/\/$/, '')}/api/agent/v1/join`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: options.joinToken, hello: await options.describe() })
			});
			const body = (await response.json().catch(() => null)) as {
				error?: { message?: string };
			} | null;
			if (!response.ok) {
				throw new ControlPlaneError(
					response.status,
					body?.error?.message ?? `HTTP ${response.status}`
				);
			}
			const joined = AgentJoined.parse(body);
			mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
			writeFileSync(file, joined.token + '\n', { mode: 0o600, flag: 'wx' });
			log(`[agent] joined as node ${joined.name}`);
			return joined.token;
		} catch (error) {
			if (error instanceof ControlPlaneError && error.status < 500) {
				throw new Error(`Tramline refused to enroll this machine: ${error.message}`);
			}
			log(
				`[agent] can't reach ${options.url} to join yet: ${error instanceof Error ? error.message : String(error)}`
			);
			await sleep(options.retryMs ?? 5_000);
		}
	}
}
