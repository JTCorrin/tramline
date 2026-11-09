import { NetworkingConfig } from '@tramline/contracts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as changes from '../domain/changes';
import * as environments from '../domain/environments';
import * as nodes from '../domain/nodes';
import * as projects from '../domain/projects';
import * as services from '../domain/services';
import { grantInstallAdmin, seedCtx, testSecrets } from '../testing';
import { buildDesiredState } from './desired';
import { reconcile } from './reconciler';
import { ensureLocalNode, recordHello, recordReport } from './registry';

function setup() {
	const ctx = grantInstallAdmin(seedCtx());
	ctx.settings = {
		...ctx.settings,
		dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-contain-'))
	};
	const { node: local } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
	recordHello(ctx.db, local.id, {
		protocol: 1,
		agentVersion: 'test',
		hostname: 'box',
		os: 'linux',
		arch: 'amd64',
		cpus: 4,
		memoryMb: 8192,
		docker: { version: '27.0.0' }
	});
	const project = projects.create(ctx, { name: 'Shop' });
	const [env] = environments.list(ctx, project.id);
	const add = (privateNetworks?: string[]) => {
		const svc = services.create(ctx, {
			projectId: project.id,
			kind: 'image',
			source: { type: 'image', image: 'traefik/whoami' }
		});
		services.stageConfig(ctx, svc.id, env!.id, {
			build: { scan: 'off' },
			...(privateNetworks ? { networking: { privateNetworks } } : {})
		});
		return svc;
	};
	return { ctx, local, env: env!, add };
}

describe('containment', () => {
	it("tells the agent a service's private ranges, and nothing for the rest", () => {
		const { ctx, local, env, add } = setup();
		const nas = add(['192.168.1.20', '10.0.5.0/24']);
		const plain = add();
		changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);

		const containers = buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).containers;
		expect(containers.find((c) => c.serviceId === nas.id)!.privateNetworks).toEqual([
			'192.168.1.20/32',
			'10.0.5.0/24'
		]);
		// no field at all, so containers from before containment keep their spec hash
		expect(containers.find((c) => c.serviceId === plain.id)).not.toHaveProperty('privateNetworks');
		// a workload gets no platform credential: no agent, API or join token, no Docker socket
		for (const c of containers) {
			expect(
				Object.keys(c.env)
					.filter((k) => k.startsWith('TRAMLINE_'))
					.sort()
			).toEqual([
				'TRAMLINE_ENVIRONMENT_ID',
				'TRAMLINE_ENVIRONMENT_NAME',
				'TRAMLINE_PRIVATE_DOMAIN',
				'TRAMLINE_SERVICE_ID',
				'TRAMLINE_SERVICE_NAME'
			]);
			expect(JSON.stringify(c)).not.toMatch(/\btl(node|join|inv|setup)?_[A-Za-z0-9]|docker\.sock/);
		}
	});

	it('never opens the cloud metadata endpoint, and takes only IPv4', () => {
		const base = { port: null, publicDomain: false, tcpProxy: false, tcpAllowlist: [] };
		const parse = (privateNetworks: string[]) =>
			NetworkingConfig.safeParse({ ...base, privateNetworks }).success;
		expect(parse(['192.168.1.20', '10.0.0.0/8'])).toBe(true);
		expect(parse(['169.254.169.254'])).toBe(false);
		expect(parse(['169.254.0.0/16'])).toBe(false);
		expect(parse(['168.63.129.16'])).toBe(false);
		expect(parse(['fd00::1'])).toBe(false);
		expect(parse(['192.168.1.0/24 -j ACCEPT'])).toBe(false);
	});

	it('shows what the agent says about containment on the Nodes page', () => {
		const { ctx, local } = setup();
		const summary = () => nodes.list(ctx).find((n) => n.id === local.id)!;
		recordReport(ctx.db, local.id, { containers: [], revision: null });
		// an older agent says nothing
		expect(summary().containment).toBeNull();

		recordReport(ctx.db, local.id, {
			containers: [],
			revision: null,
			containment: { state: 'unsupported', detail: "Docker's DOCKER-USER chain isn't there" }
		});
		expect(summary().containment).toEqual({
			state: 'unsupported',
			detail: "Docker's DOCKER-USER chain isn't there"
		});
		// a report without it keeps what was said last
		recordReport(ctx.db, local.id, { containers: [], revision: null });
		expect(summary().containment!.state).toBe('unsupported');
	});
});
