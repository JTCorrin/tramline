import { describe, expect, it } from 'vitest';
import { deployment } from '../db/schema';
import { seedCtx, testSecrets } from '../testing';
import * as changes from './changes';
import * as environments from './environments';
import * as projects from './projects';
import * as services from './services';
import * as variables from './variables';

function setup() {
	const ctx = seedCtx();
	const project = projects.create(ctx, { name: 'Vault' });
	const [env] = environments.list(ctx, project.id);
	const api = services.create(ctx, {
		projectId: project.id,
		kind: 'image',
		source: { type: 'image', image: 'nginx' }
	});
	const vars = (c = ctx) => variables.list(c, { environmentId: env!.id, serviceId: api.id });
	const stage = (edits: {
		set?: Record<string, string>;
		unset?: string[];
		seal?: string[];
		restore?: string[];
	}) =>
		variables.stage(ctx, {
			environmentId: env!.id,
			serviceId: api.id,
			set: {},
			unset: [],
			...edits
		});
	return { ctx, env: env!, api, vars, stage };
}

describe('sealed variables', () => {
	it('hide the value immediately, but still deploy and resolve it', () => {
		const { ctx, env, api, vars, stage } = setup();
		stage({ set: { API_KEY: 'sk_live_123', URL: 'https://x?key=${{API_KEY}}' } });
		expect(stage({ seal: ['API_KEY'] }).find((v) => v.key === 'API_KEY')).toEqual({
			key: 'API_KEY',
			value: null,
			sealed: true,
			staged: 'added'
		});

		changes.deploy(ctx, env.id);
		expect(vars().find((v) => v.key === 'API_KEY')).toMatchObject({
			value: null,
			sealed: true,
			staged: null
		});

		const row = ctx.db
			.select()
			.from(deployment)
			.all()
			.find((d) => d.serviceId === api.id)!;
		const resolved = JSON.parse(testSecrets.decrypt(row.variables));
		expect(resolved).toMatchObject({ API_KEY: 'sk_live_123', URL: 'https://x?key=sk_live_123' });
	});

	it('can be replaced but not revealed, and keep their seal', () => {
		const { ctx, env, vars, stage } = setup();
		stage({ set: { TOKEN: 'one' } });
		stage({ seal: ['TOKEN'] });
		changes.deploy(ctx, env.id);

		stage({ set: { TOKEN: 'two' } });
		expect(vars()).toEqual([{ key: 'TOKEN', value: null, sealed: true, staged: 'modified' }]);
	});

	it('can be removed and restored without knowing the value', () => {
		const { ctx, env, vars, stage } = setup();
		stage({ set: { TOKEN: 'one' } });
		stage({ seal: ['TOKEN'] });
		changes.deploy(ctx, env.id);

		stage({ unset: ['TOKEN'] });
		expect(vars()[0]).toMatchObject({ staged: 'removed', sealed: true });
		stage({ restore: ['TOKEN'] });
		expect(vars()[0]).toMatchObject({ staged: null, sealed: true });
		expect(changes.summary(ctx, env.id).count).toBe(0);
	});

	it('go away with the variable, so a new variable with the same key starts unsealed', () => {
		const { ctx, env, vars, stage } = setup();
		stage({ set: { TOKEN: 'one' } });
		stage({ seal: ['TOKEN'] });
		changes.deploy(ctx, env.id);
		stage({ unset: ['TOKEN'] });
		changes.deploy(ctx, env.id);
		expect(vars()).toEqual([]);

		stage({ set: { TOKEN: 'visible' } });
		expect(vars()[0]).toMatchObject({ value: 'visible', sealed: false });
	});

	it('are dropped when a staged variable is discarded', () => {
		const { ctx, env, vars, stage } = setup();
		changes.deploy(ctx, env.id);
		stage({ set: { DRAFT: 'x' } });
		stage({ seal: ['DRAFT'] });
		changes.discard(ctx, env.id);
		stage({ set: { DRAFT: 'y' } });
		expect(vars()[0]).toMatchObject({ value: 'y', sealed: false });
	});

	it('cannot seal a key that does not exist, and are scoped per service', () => {
		const { ctx, env, stage, vars } = setup();
		expect(() => stage({ seal: ['NOPE'] })).toThrow('Cannot seal unknown variable NOPE');
		variables.stage(ctx, { environmentId: env.id, set: { SHARED: 's' }, unset: [] });
		variables.stage(ctx, { environmentId: env.id, set: {}, unset: [], seal: ['SHARED'] });
		expect(variables.list(ctx, { environmentId: env.id })[0]).toMatchObject({
			sealed: true,
			value: null
		});
		stage({ set: { SHARED: 'per-service' } });
		expect(vars()[0]).toMatchObject({ sealed: false, value: 'per-service' });
	});
});
