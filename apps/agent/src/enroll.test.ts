import type { AgentHello } from '@tramline/contracts';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { enroll, nodeTokenFile } from './enroll';

const hello: AgentHello = {
	protocol: 1,
	agentVersion: 'test',
	hostname: 'box',
	os: 'linux',
	arch: 'arm64',
	cpus: 2,
	memoryMb: 2048,
	docker: { version: '27.0.0' }
};

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function options(fetcher: typeof fetch) {
	const stateDir = path.join(mkdtempSync(path.join(tmpdir(), 'tl-enroll-')), 'state');
	return {
		url: 'http://tramline.test/',
		joinToken: 'tljoin_abc',
		stateDir,
		describe: async () => hello,
		fetcher,
		log: () => {},
		retryMs: 1
	};
}

describe('enroll', () => {
	it('joins once and saves the node token where only the agent can read it', async () => {
		const fetcher = vi.fn<typeof fetch>(async () =>
			json(201, { nodeId: 'node_1', name: 'box', token: 'tlnode_secret' })
		);
		const opts = options(fetcher);
		expect(await enroll(opts)).toBe('tlnode_secret');

		const [url, init] = fetcher.mock.calls[0]!;
		expect(url).toBe('http://tramline.test/api/agent/v1/join');
		expect(JSON.parse(init!.body as string)).toEqual({ token: 'tljoin_abc', hello });
		expect(readFileSync(nodeTokenFile(opts.stateDir), 'utf8').trim()).toBe('tlnode_secret');
		expect(statSync(nodeTokenFile(opts.stateDir)).mode & 0o777).toBe(0o600);

		// a restart reuses the saved token; the join token is spent
		expect(await enroll({ ...opts, joinToken: '' })).toBe('tlnode_secret');
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('retries while the control plane is unreachable', async () => {
		let calls = 0;
		const fetcher = vi.fn<typeof fetch>(async () => {
			if (++calls < 3) throw new TypeError('fetch failed');
			if (calls === 3) return json(502, {});
			return json(201, { nodeId: 'node_1', name: 'box', token: 'tlnode_x' });
		});
		expect(await enroll(options(fetcher))).toBe('tlnode_x');
		expect(fetcher).toHaveBeenCalledTimes(4);
	});

	it('gives up when the join token is refused', async () => {
		const fetcher = vi.fn<typeof fetch>(async () =>
			json(401, { error: { message: 'This join token is invalid or has expired' } })
		);
		await expect(enroll(options(fetcher))).rejects.toThrow(
			'Tramline refused to enroll this machine: This join token is invalid or has expired'
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
