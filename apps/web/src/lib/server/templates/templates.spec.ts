import { Template, type AgentHello, type TemplateInput } from '@tramline/contracts';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deployment } from '../db/schema';
import * as changes from '../domain/changes';
import * as canvas from '../domain/canvas';
import * as environments from '../domain/environments';
import { getStaged } from '../domain/staging';
import * as projects from '../domain/projects';
import * as services from '../domain/services';
import * as variables from '../domain/variables';
import { buildDesiredState } from '../nodes/desired';
import { containerName } from '../nodes/names';
import { reconcile } from '../nodes/reconciler';
import { ensureLocalNode, recordHello, recordReport } from '../nodes/registry';
import { seedCtx, testSecrets } from '../testing';
import * as templates from './index';

const DIGEST = `@sha256:${'a'.repeat(64)}`;

/** A small stack that uses everything a template can: questions, secrets, a JWT, references and a file. */
const stack: TemplateInput = {
	id: 'stack',
	version: 1,
	name: 'Stack',
	tagline: 'A test stack',
	description: 'For tests',
	icon: 'layout-template',
	questions: [
		{ key: 'SITE_URL', label: 'Site URL', required: true },
		{ key: 'SMTP_PASS', label: 'SMTP password', secret: true }
	],
	services: [
		{
			key: 'db',
			name: 'db',
			database: 'postgres',
			image: `postgres:17${DIGEST}`,
			config: { networking: { port: 5432 }, volume: { mountPath: '/var/lib/postgresql/data' } },
			variables: { POSTGRES_PASSWORD: { generate: 'secret', length: 24 } }
		},
		{
			key: 'api',
			name: 'api',
			image: `acme/api:1${DIGEST}`,
			config: {
				networking: { port: 8080, publicDomain: true },
				deploy: {
					dependsOn: ['db'],
					memoryRequestMb: 128,
					cpuRequest: 0.5,
					files: [
						{
							path: '/etc/api/config.yml',
							content: 'site: ${{ answers.SITE_URL }}\nkey: ${{ ANON_KEY }}\ndb: ${{ DB_HOST }}\n'
						}
					]
				}
			},
			variables: {
				JWT_SECRET: { generate: 'secret', length: 40 },
				ANON_KEY: {
					generate: 'jwt',
					secret: 'JWT_SECRET',
					claims: { role: 'anon' },
					sealed: false
				},
				DB_HOST: '${{ db.TRAMLINE_PRIVATE_DOMAIN }}',
				DATABASE_URL:
					'postgres://postgres:${{ db.POSTGRES_PASSWORD }}@${{ DB_HOST }}:5432/postgres',
				SITE_URL: '${{ answers.SITE_URL }}',
				SMTP_PASS: '${{ answers.SMTP_PASS }}'
			},
			position: { x: 300, y: 0 }
		}
	],
	notes: ['Open ${{ api.TRAMLINE_PUBLIC_DOMAIN }} once it has deployed.']
};

function setup() {
	const ctx = seedCtx();
	ctx.settings = { ...ctx.settings, dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-tpl-')) };
	const project = projects.create(ctx, { name: 'Shop' });
	const [production] = environments.list(ctx, project.id);
	return { ctx, project, env: production! };
}

const install = (ctx: ReturnType<typeof setup>['ctx'], projectId: string, input = {}) =>
	templates.installTemplate(ctx, projectId, Template.parse(stack), {
		template: 'stack',
		answers: { SITE_URL: 'https://shop.example' },
		...input
	});

const vars = (ctx: ReturnType<typeof setup>['ctx'], environmentId: string, serviceId: string) =>
	Object.fromEntries(variables.list(ctx, { environmentId, serviceId }).map((v) => [v.key, v]));

describe('the gallery', () => {
	it('has templates that parse, with their images pinned by digest', () => {
		expect(templates.TEMPLATES.map((t) => t.id)).toEqual(
			expect.arrayContaining(['supabase', 'n8n', 'uptime-kuma'])
		);
		for (const t of templates.TEMPLATES) {
			for (const s of t.services) expect(s.image).toMatch(/@sha256:[0-9a-f]{64}$/);
		}
		expect(templates.get('n8n')).toMatchObject({
			name: 'n8n',
			services: [
				{ key: 'n8n', publicDomain: true, volume: true },
				{ key: 'postgres', icon: 'postgres', volume: true }
			],
			requests: { memoryMb: 640, cpus: 0.5 }
		});
		expect(() => templates.get('nope')).toThrow();
	});
});

describe('installing a template', () => {
	it('stages its services in every environment, each with its own sealed secrets', () => {
		const { ctx, project, env } = setup();
		const staging = environments.create(ctx, { projectId: project.id, name: 'staging' });
		const result = install(ctx, project.id, {
			answers: { SITE_URL: 'https://shop.example', SMTP_PASS: 'hunter22' },
			position: { x: 100, y: 50 }
		});
		expect(result.services.map((s) => s.name)).toEqual(['db', 'api']);
		expect(result.deployments).toEqual([]);
		expect(result.notes).toEqual(['Open ${{ api.TRAMLINE_PUBLIC_DOMAIN }} once it has deployed.']);

		const [db, api] = services.list(ctx, project.id);
		expect(db).toMatchObject({ kind: 'database', icon: 'postgres', position: { x: 100, y: 50 } });
		expect(api).toMatchObject({ kind: 'image', position: { x: 400, y: 50 } });
		expect(services.getConfig(ctx, api!.id, env.id)).toMatchObject({
			staged: true,
			effective: {
				source: { type: 'image', image: `acme/api:1${DIGEST}` },
				networking: { port: 8080, publicDomain: true },
				deploy: {
					cpuRequest: 0.5,
					files: [
						{
							path: '/etc/api/config.yml',
							content: expect.stringContaining('site: https://shop.example')
						}
					]
				}
			}
		});

		const prod = vars(ctx, env.id, api!.id);
		// generated secrets are sealed; the anon key said it needn't be
		expect(prod.JWT_SECRET).toMatchObject({ sealed: true, value: null, staged: 'added' });
		expect(prod.ANON_KEY!.sealed).toBe(false);
		// an answer to a secret question is sealed too
		expect(prod.SMTP_PASS!.sealed).toBe(true);
		expect(prod.SITE_URL!.value).toBe('https://shop.example');
		expect(prod.DATABASE_URL!.value).toBe(
			'postgres://postgres:${{ db.POSTGRES_PASSWORD }}@${{ DB_HOST }}:5432/postgres'
		);

		// a JWT signed with the environment's own secret
		const anon = prod.ANON_KEY!.value!;
		const [header, payload, signature] = anon.split('.');
		const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
		expect(claims).toMatchObject({ role: 'anon' });
		expect(claims.exp - claims.iat).toBeGreaterThan(9 * 365 * 24 * 3600);
		// sealed values aren't listed; read the staged one the way a deploy does
		const secret = testSecrets.decrypt(
			getStaged(ctx.db, env.id, api!.id).variables!.set.JWT_SECRET!
		);
		expect(secret).toMatch(/^[A-Za-z0-9]{40}$/);
		expect(createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')).toBe(
			signature
		);

		// staging got different secrets
		expect(vars(ctx, staging.id, api!.id).ANON_KEY!.value).not.toBe(anon);
	});

	it('renames services the project already has, and points references at the new names', () => {
		const { ctx, project, env } = setup();
		install(ctx, project.id);
		const second = install(ctx, project.id);
		expect(second.services.map((s) => s.name)).toEqual(['db-2', 'api-2']);
		const api = vars(ctx, env.id, second.services[1]!.id);
		expect(api.DB_HOST!.value).toBe('${{ db-2.TRAMLINE_PRIVATE_DOMAIN }}');
		expect(api.DATABASE_URL!.value).toContain('${{ db-2.POSTGRES_PASSWORD }}');
		expect(second.notes).toEqual([
			'Open ${{ api-2.TRAMLINE_PUBLIC_DOMAIN }} once it has deployed.'
		]);
		// and its start order follows the rename
		expect(
			services.getConfig(ctx, second.services[1]!.id, env.id).effective.deploy.dependsOn
		).toEqual(['db-2']);
	});

	it('runs every service on the node chosen, and the canvas says where each one is', () => {
		const { ctx, project, env } = setup();
		const { node: local } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
		expect(() => install(ctx, project.id, { node: 'node_nope' })).toThrow();
		const result = install(ctx, project.id, { node: local.id });
		for (const s of result.services) {
			expect(services.getConfig(ctx, s.id, env.id).effective.deploy.node).toBe(local.id);
		}
		expect(canvas.get(ctx, env.id).services.map((s) => s.nodes)).toEqual([[], []]);
		recordHello(ctx.db, local.id, {
			protocol: 1,
			agentVersion: 'test',
			hostname: 'box',
			os: 'linux',
			arch: 'amd64',
			cpus: 4,
			memoryMb: 8192,
			docker: { version: '27.0.0' },
			features: ['files']
		});
		recordReport(ctx.db, local.id, { containers: [], revision: null });
		for (const s of result.services) {
			services.stageConfig(ctx, s.id, env.id, { build: { scan: 'off' } });
		}
		changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		// the database is placed; the api waits for it to be online
		expect(canvas.get(ctx, env.id).services.map((s) => s.nodes)).toEqual([['local'], []]);
	});

	it('asks for required answers, and takes none that smuggle in a reference', () => {
		const { ctx, project } = setup();
		expect(() => install(ctx, project.id, { answers: {} })).toThrow('Site URL is required');
		expect(() =>
			install(ctx, project.id, { answers: { SITE_URL: '${{ db.POSTGRES_PASSWORD }}' } })
		).toThrow("Site URL can't contain");
		expect(services.list(ctx, project.id)).toEqual([]);
	});

	it('deploys straight away when asked, and writes its files with their references resolved', () => {
		const { ctx, project, env } = setup();
		const { node: local } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
		const hello: AgentHello = {
			protocol: 1,
			agentVersion: 'test',
			hostname: 'box',
			os: 'linux',
			arch: 'amd64',
			cpus: 4,
			memoryMb: 8192,
			docker: { version: '27.0.0' }
		};
		// an agent from before config files can't take a service that has them
		recordHello(ctx.db, local.id, hello);
		recordReport(ctx.db, local.id, { containers: [], revision: null });
		const early = install(ctx, project.id);
		for (const s of early.services) {
			services.stageConfig(ctx, s.id, env.id, { build: { scan: 'off' } });
		}
		changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		const latest = (serviceId: string) =>
			ctx.db
				.select()
				.from(deployment)
				.all()
				.filter((d) => d.serviceId === serviceId)
				.at(-1)!;
		// the database has no files, so it runs; the api starts after it
		const earlyDb = latest(early.services[0]!.id);
		expect(earlyDb.nodeId).toBe(local.id);
		expect(latest(early.services[1]!.id).message).toBe(
			'Waiting for db to be online, which it starts after'
		);
		recordReport(ctx.db, local.id, {
			revision: null,
			containers: [
				{
					name: containerName(earlyDb.id, 0),
					deploymentId: earlyDb.id,
					replica: 0,
					state: 'running',
					healthy: null,
					exitCode: null,
					restartCount: 0,
					error: null,
					startedAt: new Date(Date.now() - 10_000).toISOString()
				}
			]
		});
		reconcile(ctx.db, ctx.settings);
		reconcile(ctx.db, ctx.settings);
		// once it's online, the api still waits: this agent can't write its config files
		expect(latest(early.services[1]!.id)).toMatchObject({
			status: 'queued',
			message:
				"Waiting for a node whose agent can write this service's config files: update the agent on local"
		});

		recordHello(ctx.db, local.id, { ...hello, features: ['files'] });
		recordReport(ctx.db, local.id, { containers: [], revision: null });
		// deployed straight away (scanned first, as every image is)
		const scanned = install(ctx, project.id, { deploy: env.id });
		expect(scanned.deployments).toHaveLength(2);
		expect(changes.summary(ctx, env.id).count).toBe(0);

		// without the scan, the containers go straight to the node
		const result = install(ctx, project.id);
		for (const s of result.services) {
			services.stageConfig(ctx, s.id, env.id, { build: { scan: 'off' } });
		}
		changes.deploy(ctx, env.id);
		reconcile(ctx.db, ctx.settings);
		// the api starts after the database: once it's online
		const dbDeployment = ctx.db
			.select()
			.from(deployment)
			.all()
			.find((d) => d.serviceId === result.services[0]!.id)!;
		recordReport(ctx.db, local.id, {
			revision: null,
			containers: [
				{
					name: containerName(dbDeployment.id, 0),
					deploymentId: dbDeployment.id,
					replica: 0,
					state: 'running',
					healthy: null,
					exitCode: null,
					restartCount: 0,
					error: null,
					startedAt: new Date(Date.now() - 10_000).toISOString()
				}
			]
		});
		reconcile(ctx.db, ctx.settings);
		reconcile(ctx.db, ctx.settings);

		const containers = buildDesiredState(ctx.db, testSecrets, ctx.settings, local.id).containers;
		const api = containers.find((c) => c.serviceId === result.services[1]!.id)!;
		const [file] = api.files!;
		expect(file!.path).toBe('/etc/api/config.yml');
		expect(file!.content).toMatch(
			/^site: https:\/\/shop\.example\nkey: [\w-]+\.[\w-]+\.[\w-]+\ndb: db-3\.production\.tramline\.internal\n$/
		);
		expect(api.env.DATABASE_URL).toMatch(
			/^postgres:\/\/postgres:[A-Za-z0-9]{24}@db-3\.production\.tramline\.internal:5432\/postgres$/
		);
		// a container without files doesn't carry the field
		expect(containers.find((c) => c.serviceId === result.services[0]!.id)!.files).toBeUndefined();
	});

	it('refuses a deploy into another project’s environment', () => {
		const { ctx, project } = setup();
		const other = projects.create(ctx, { name: 'Other' });
		const [otherEnv] = environments.list(ctx, other.id);
		expect(() => install(ctx, project.id, { deploy: otherEnv!.id })).toThrow();
		expect(services.list(ctx, project.id)).toEqual([]);
	});
});
