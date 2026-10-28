import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { deployment } from '../db/schema';
import { redactorFor } from '../nodes/redact';
import { seedCtx, testSecrets } from '../testing';
import * as changes from './changes';
import type { Ctx } from './context';
import * as environments from './environments';
import * as projects from './projects';
import * as services from './services';
import * as variables from './variables';

function setup() {
	const ctx = seedCtx();
	const project = projects.create(ctx, { name: 'Shop' });
	const [env] = environments.list(ctx, project.id);
	const add = (name: string, set: Record<string, string> = {}) => {
		const svc = services.create(ctx, {
			projectId: project.id,
			kind: 'image',
			name,
			source: { type: 'image', image: 'traefik/whoami' }
		});
		services.stageConfig(ctx, svc.id, env!.id, { build: { scan: 'off' } });
		if (Object.keys(set).length) {
			variables.stage(ctx, { environmentId: env!.id, serviceId: svc.id, set, unset: [] });
		}
		return svc;
	};
	return { ctx, env: env!, add };
}

const deployed = (ctx: Ctx, envId: string) => changes.deploy(ctx, envId).map((d) => d.serviceId);

const snapshot = (ctx: Ctx, deploymentId: string) => {
	const row = ctx.db.select().from(deployment).where(eq(deployment.id, deploymentId)).get()!;
	return {
		variables: JSON.parse(testSecrets.decrypt(row.variables)) as Record<string, string>,
		sensitiveKeys: row.sensitiveKeys
	};
};

describe('changes reach every service that uses them', () => {
	it('redeploys a service whose reference changed, directly or through a chain', () => {
		const { ctx, env, add } = setup();
		const a = add('a', { VALUE: 'one' });
		const b = add('b', { VALUE: '${{a.VALUE}}' });
		const c = add('c', { VALUE: '${{b.VALUE}}-c' });
		const d = add('d', { OTHER: 'unrelated' });
		changes.deploy(ctx, env.id);

		variables.stage(ctx, {
			environmentId: env.id,
			serviceId: a.id,
			set: { VALUE: 'two' },
			unset: []
		});
		const summary = changes.summary(ctx, env.id);
		expect(summary.changes.map((c) => c.label).sort()).toEqual(['a', 'b', 'c']);
		expect(summary.changes.find((x) => x.label === 'c')!.details).toEqual([
			'Redeploys with new values: VALUE'
		]);

		const created = changes.deploy(ctx, env.id);
		expect(created.map((x) => x.serviceId).sort()).toEqual([a.id, b.id, c.id].sort());
		expect(snapshot(ctx, created.find((x) => x.serviceId === c.id)!.id).variables.VALUE).toBe(
			'two-c'
		);
		expect(created.map((x) => x.serviceId)).not.toContain(d.id);
	});

	it('follows shared variables through other references too', () => {
		const { ctx, env, add } = setup();
		variables.stage(ctx, { environmentId: env.id, set: { HOST: 'db1' }, unset: [] });
		const a = add('a', { URL: 'postgres://${{shared.HOST}}' });
		const b = add('b', { URL: '${{a.URL}}/app' });
		changes.deploy(ctx, env.id);

		variables.stage(ctx, { environmentId: env.id, set: { HOST: 'db2' }, unset: [] });
		expect(deployed(ctx, env.id).sort()).toEqual([a.id, b.id].sort());
	});
});

describe('sealed values stay out of logs under any name', () => {
	it('masks a sealed shared value copied into an ordinary variable', () => {
		const { ctx, env, add } = setup();
		variables.stage(ctx, {
			environmentId: env.id,
			set: { LICENSE: 'lic-0123456789' },
			unset: [],
			seal: ['LICENSE']
		});
		const app = add('app', { VALUE: '${{shared.LICENSE}}', NOTE: 'hello world' });
		const [dep] = changes.deploy(ctx, env.id).filter((x) => x.serviceId === app.id);
		expect(snapshot(ctx, dep!.id).sensitiveKeys).toEqual(['VALUE']);
		expect(redactorFor(ctx.db, testSecrets, dep!.id)('printing lic-0123456789 now')).toBe(
			'printing [redacted:VALUE] now'
		);
	});

	it('masks another service’s sealed value, and keeps doing so after the seal goes', () => {
		const { ctx, env, add } = setup();
		const api = add('api', { SIGNING: 'sign-abcdef123' });
		variables.stage(ctx, {
			environmentId: env.id,
			serviceId: api.id,
			set: {},
			unset: [],
			seal: ['SIGNING']
		});
		const worker = add('worker', { KEYCOPY: 'x:${{api.SIGNING}}' });
		const [dep] = changes.deploy(ctx, env.id).filter((x) => x.serviceId === worker.id);
		const redact = () => redactorFor(ctx.db, testSecrets, dep!.id)('x:sign-abcdef123');
		expect(redact()).toBe('[redacted:KEYCOPY]');

		// the source variable is removed (and its seal with it); the old snapshot stays protected
		variables.stage(ctx, { environmentId: env.id, serviceId: api.id, set: {}, unset: ['SIGNING'] });
		changes.discard(ctx, env.id);
		expect(redact()).toBe('[redacted:KEYCOPY]');
	});

	it('masks a value sealed after it was deployed, without waiting for the cache', () => {
		const { ctx, env, add } = setup();
		const app = add('app', { PLAIN: 'plain-value-123' });
		const [dep] = changes.deploy(ctx, env.id);
		expect(redactorFor(ctx.db, testSecrets, dep!.id)('plain-value-123')).toBe('plain-value-123');
		variables.stage(ctx, {
			environmentId: env.id,
			serviceId: app.id,
			set: {},
			unset: [],
			seal: ['PLAIN']
		});
		expect(redactorFor(ctx.db, testSecrets, dep!.id)('plain-value-123')).toBe('[redacted:PLAIN]');
	});
});
