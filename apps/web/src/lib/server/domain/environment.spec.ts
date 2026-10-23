import { describe, expect, it } from 'vitest';
import { seedCtx, testSecrets } from '../testing';
import * as canvas from './canvas';
import * as changes from './changes';
import * as deployments from './deployments';
import * as environments from './environments';
import * as projects from './projects';
import * as services from './services';
import * as variables from './variables';

function setup() {
	const ctx = seedCtx();
	const project = projects.create(ctx, { name: 'Shop' });
	const [production] = environments.list(ctx, project.id);
	return { ctx, project, env: production! };
}

describe('projects', () => {
	it('start with a production environment', () => {
		const { ctx, project } = setup();
		expect(environments.list(ctx, project.id).map((e) => e.name)).toEqual(['production']);
	});
});

describe('services and staged changes', () => {
	it('stages a new database with generated variables until deploy', () => {
		const { ctx, project, env } = setup();
		const pg = services.create(ctx, {
			projectId: project.id,
			kind: 'database',
			engine: 'postgres'
		});

		expect(pg).toMatchObject({ name: 'Postgres', kind: 'database', icon: 'postgres' });
		expect(services.getConfig(ctx, pg.id, env.id)).toMatchObject({
			applied: null,
			staged: true,
			effective: { source: { type: 'image', image: 'postgres:17' }, networking: { port: 5432 } }
		});

		const vars = variables.list(ctx, { environmentId: env.id, serviceId: pg.id });
		expect(vars.every((v) => v.staged === 'added')).toBe(true);
		expect(vars.find((v) => v.key === 'POSTGRES_PASSWORD')?.value).toMatch(/^[\w-]{32}$/);

		const summary = changes.summary(ctx, env.id);
		expect(summary.count).toBe(1);
		expect(summary.changes[0]).toMatchObject({ label: 'Postgres' });
		expect(summary.changes[0]!.details).toContain('New service');
		expect(summary.changes[0]!.details).toContain('+ DATABASE_URL');
	});

	it('derives unique names from the source', () => {
		const { ctx, project } = setup();
		const image = (image: string) =>
			services.create(ctx, {
				projectId: project.id,
				kind: 'image',
				source: { type: 'image', image }
			});

		expect(image('ghcr.io/acme/api:1.2').name).toBe('api');
		expect(image('acme/api').name).toBe('api-2');
		expect(
			services.create(ctx, {
				projectId: project.id,
				kind: 'repo',
				source: {
					type: 'repo',
					repo: 'https://github.com/acme/web.git',
					branch: 'main',
					rootDirectory: '/'
				}
			}).name
		).toBe('web');
	});

	it('deploys staged changes, resolves references and queues deployments', () => {
		const { ctx, project, env } = setup();
		const pg = services.create(ctx, {
			projectId: project.id,
			kind: 'database',
			engine: 'postgres'
		});
		const api = services.create(ctx, {
			projectId: project.id,
			kind: 'image',
			source: { type: 'image', image: 'traefik/whoami' }
		});
		variables.stage(ctx, {
			environmentId: env.id,
			serviceId: api.id,
			set: { DATABASE_URL: '${{Postgres.DATABASE_URL}}' },
			unset: []
		});

		expect(canvas.get(ctx, env.id).edges).toEqual([
			{ id: `${pg.id}->${api.id}`, source: pg.id, target: api.id }
		]);

		const queued = changes.deploy(ctx, env.id);
		expect(queued.map((d) => [d.serviceId, d.status, d.source])).toEqual([
			[pg.id, 'queued', 'postgres:17'],
			[api.id, 'queued', 'traefik/whoami']
		]);

		expect(changes.summary(ctx, env.id).count).toBe(0);
		expect(services.getConfig(ctx, api.id, env.id).applied?.source).toEqual({
			type: 'image',
			image: 'traefik/whoami'
		});
		expect(variables.list(ctx, { environmentId: env.id, serviceId: api.id })).toEqual([
			{ key: 'DATABASE_URL', value: '${{Postgres.DATABASE_URL}}', staged: null }
		]);

		// the deployment snapshot holds fully resolved values
		const row = ctx.db.query.deployment
			.findFirst({ where: (d, { eq }) => eq(d.serviceId, api.id) })
			.sync()!;
		const resolved = JSON.parse(testSecrets.decrypt(row.variables));
		const password = variables
			.list(ctx, { environmentId: env.id, serviceId: pg.id })
			.find((v) => v.key === 'POSTGRES_PASSWORD')!.value;
		expect(resolved.DATABASE_URL).toBe(
			`postgresql://postgres:${password}@postgres.production.tramline.internal:5432/app`
		);
		expect(resolved.TRAMLINE_SERVICE_NAME).toBe(api.name);

		expect(canvas.get(ctx, env.id).services.map((s) => [s.name, s.status, s.staged])).toEqual([
			['Postgres', 'queued', false],
			['whoami', 'queued', false]
		]);
		expect(deployments.list(ctx, { serviceId: api.id, environmentId: env.id })).toHaveLength(1);
	});

	it('stages config edits as a minimal diff and drops no-op edits', () => {
		const { ctx, project, env } = setup();
		const api = services.create(ctx, {
			projectId: project.id,
			kind: 'image',
			source: { type: 'image', image: 'nginx' }
		});
		changes.deploy(ctx, env.id);

		const view = services.stageConfig(ctx, api.id, env.id, { deploy: { replicas: 3 } });
		expect(view).toMatchObject({ staged: true, effective: { deploy: { replicas: 3 } } });
		expect(changes.summary(ctx, env.id).changes[0]!.details).toEqual(['deploy.replicas: 1 → 3']);

		services.stageConfig(ctx, api.id, env.id, { deploy: { replicas: 1 } });
		expect(changes.summary(ctx, env.id).count).toBe(0);
	});

	it('cancels a variable edit that restores the deployed value', () => {
		const { ctx, project, env } = setup();
		const api = services.create(ctx, { projectId: project.id, kind: 'empty' });
		variables.stage(ctx, { environmentId: env.id, serviceId: api.id, set: { A: '1' }, unset: [] });
		changes.deploy(ctx, env.id);

		variables.stage(ctx, { environmentId: env.id, serviceId: api.id, set: { A: '2' }, unset: [] });
		expect(variables.list(ctx, { environmentId: env.id, serviceId: api.id })[0]).toMatchObject({
			value: '2',
			staged: 'modified'
		});
		variables.stage(ctx, { environmentId: env.id, serviceId: api.id, set: { A: '1' }, unset: [] });
		expect(changes.summary(ctx, env.id).count).toBe(0);

		variables.stage(ctx, { environmentId: env.id, serviceId: api.id, set: {}, unset: ['A'] });
		expect(variables.list(ctx, { environmentId: env.id, serviceId: api.id })[0]!.staged).toBe(
			'removed'
		);
	});

	it('does not queue deployments for services without a source', () => {
		const { ctx, project, env } = setup();
		services.create(ctx, { projectId: project.id, kind: 'empty' });
		expect(changes.deploy(ctx, env.id)).toEqual([]);
		expect(() => changes.deploy(ctx, env.id)).toThrowError(/no changes/);
	});

	it('redeploys services that use a changed shared variable', () => {
		const { ctx, project, env } = setup();
		const api = services.create(ctx, {
			projectId: project.id,
			kind: 'image',
			source: { type: 'image', image: 'nginx' }
		});
		variables.stage(ctx, {
			environmentId: env.id,
			serviceId: api.id,
			set: { R: '${{shared.REGION}}' },
			unset: []
		});
		changes.deploy(ctx, env.id);

		variables.stage(ctx, { environmentId: env.id, set: { REGION: 'eu' }, unset: [] });
		expect(changes.summary(ctx, env.id).changes[0]).toMatchObject({
			serviceId: null,
			details: ['+ REGION']
		});
		expect(changes.deploy(ctx, env.id).map((d) => d.serviceId)).toEqual([api.id]);
	});

	it('refuses to deploy a reference cycle and leaves changes staged', () => {
		const { ctx, project, env } = setup();
		const a = services.create(ctx, { projectId: project.id, kind: 'empty', name: 'a' });
		const b = services.create(ctx, { projectId: project.id, kind: 'empty', name: 'b' });
		variables.stage(ctx, {
			environmentId: env.id,
			serviceId: a.id,
			set: { X: '${{b.Y}}' },
			unset: []
		});
		variables.stage(ctx, {
			environmentId: env.id,
			serviceId: b.id,
			set: { Y: '${{a.X}}' },
			unset: []
		});

		expect(() => changes.deploy(ctx, env.id)).toThrowError(/loop/);
		expect(changes.summary(ctx, env.id).count).toBe(2);
	});

	it('discard removes never-deployed services and staged edits', () => {
		const { ctx, project, env } = setup();
		const kept = services.create(ctx, { projectId: project.id, kind: 'empty', name: 'kept' });
		changes.deploy(ctx, env.id);
		services.create(ctx, { projectId: project.id, kind: 'empty', name: 'draft' });
		variables.stage(ctx, { environmentId: env.id, serviceId: kept.id, set: { A: '1' }, unset: [] });

		changes.discard(ctx, env.id);
		expect(services.list(ctx, project.id).map((s) => s.name)).toEqual(['kept']);
		expect(changes.summary(ctx, env.id).count).toBe(0);
	});
});

describe('environments', () => {
	it('copy service config from the first environment as staged creates', () => {
		const { ctx, project, env } = setup();
		const api = services.create(ctx, {
			projectId: project.id,
			kind: 'image',
			source: { type: 'image', image: 'nginx' }
		});
		changes.deploy(ctx, env.id);

		const staging = environments.create(ctx, { projectId: project.id, name: 'staging' });
		expect(services.getConfig(ctx, api.id, staging.id)).toMatchObject({
			applied: null,
			staged: true,
			effective: { source: { image: 'nginx' } }
		});
		expect(changes.summary(ctx, env.id).count).toBe(0);

		expect(() => environments.create(ctx, { projectId: project.id, name: 'staging' })).toThrow(
			/already exists/
		);
		environments.remove(ctx, staging.id);
		expect(() => environments.remove(ctx, env.id)).toThrow(/at least one environment/);
	});

	it('are isolated between organizations', () => {
		const { ctx, project, env } = setup();
		const other = seedCtx(ctx.db);
		expect(() => environments.list(other, project.id)).toThrow('Project not found');
		expect(() => changes.deploy(other, env.id)).toThrow('Environment not found');
		expect(() => services.create(other, { projectId: project.id, kind: 'empty' })).toThrow(
			'Project not found'
		);
	});
});
