import { NetworkingConfig } from '@tramline/contracts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as changes from '../domain/changes';
import * as environments from '../domain/environments';
import * as metrics from '../domain/metrics';
import * as nodes from '../domain/nodes';
import { evaluateAlerts, SECURITY_WINDOW_MS } from '../metrics/alerts';
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

	it("records what a node's service containers tried, alerts, and resolves once they stop", () => {
		const { ctx, local, env, add } = setup();
		const svc = add();
		const [dep] = changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		const tried = (kind: 'metadata' | 'private' | 'host' | 'scan', count: number, id = dep!.id) =>
			recordReport(ctx.db, local.id, {
				containers: [],
				revision: null,
				security: [{ container: 'tl-x', deploymentId: id, kind, count }]
			});
		tried('metadata', 3);
		tried('metadata', 2);
		tried('scan', 900);
		// a node speaks only for its own deployments
		tried('host', 5, 'dep_elsewhere');

		const events = metrics.securityEvents(ctx, svc.id, env.id);
		expect(events.map((e) => [e.kind, e.count]).sort()).toEqual([
			['metadata', 5],
			['scan', 900]
		]);
		expect(events[0]).toMatchObject({ deploymentId: dep!.id, nodeName: 'local' });
		// another organization sees none of it
		expect(() => metrics.securityEvents(seedCtx(ctx.db), svc.id, env.id)).toThrow();

		const now = Date.now();
		const { opened } = evaluateAlerts(ctx.db, now);
		expect(opened).toEqual([
			expect.objectContaining({
				kind: 'service_security',
				serviceId: svc.id,
				message: expect.stringMatching(
					/was blocked: .*5 attempts to reach the cloud metadata endpoint.*opened 900 connections fast enough to be a scan/
				)
			})
		]);
		expect(evaluateAlerts(ctx.db, now + 60_000).opened).toEqual([]);
		// quiet for the whole window: resolved
		const { resolved } = evaluateAlerts(ctx.db, now + SECURITY_WINDOW_MS + 120_000);
		expect(resolved.map((a) => a.kind)).toEqual(['service_security']);
	});
});
