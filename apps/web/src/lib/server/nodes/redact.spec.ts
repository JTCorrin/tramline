import { describe, expect, it } from 'vitest';
import { createRedactor } from './redact';

describe('createRedactor', () => {
	const redact = createRedactor(
		{
			POSTGRES_PASSWORD: 'hunter2hunter2',
			API_KEY: 'sk_live_abcdef',
			STRIPE_TOKEN: 'tok_123456',
			LICENSE: 'open-sesame', // sealed below, despite an innocent name
			REGION: 'eu-west-1', // not secret
			DEBUG_PASSWORD: '123', // too short to redact safely
			DATABASE_URL: 'postgresql://postgres:hunter2hunter2@pg.internal:5432/app'
		},
		new Set(['LICENSE'])
	);

	it('replaces secret values with their key', () => {
		expect(redact('connecting with hunter2hunter2 and sk_live_abcdef')).toBe(
			'connecting with [redacted:POSTGRES_PASSWORD] and [redacted:API_KEY]'
		);
		expect(redact('license=open-sesame token=tok_123456')).toBe(
			'license=[redacted:LICENSE] token=[redacted:STRIPE_TOKEN]'
		);
	});

	it('replaces the longest match first', () => {
		expect(redact('url postgresql://postgres:hunter2hunter2@pg.internal:5432/app')).toBe(
			'url [redacted:DATABASE_URL]'
		);
	});

	it('leaves ordinary and short values alone', () => {
		expect(redact('region eu-west-1, debug 123')).toBe('region eu-west-1, debug 123');
	});

	it('strips passwords from any URL, even ones it was not told about', () => {
		expect(redact('GET redis://default:s3cr3t@cache:6379 ok')).toBe(
			'GET redis://default:[redacted]@cache:6379 ok'
		);
		expect(redact('see https://example.com/a:b and mailto:x@y')).toBe(
			'see https://example.com/a:b and mailto:x@y'
		);
	});
});

describe('redactorFor', () => {
	it('uses the deployment snapshot and the current seals', async () => {
		const { seedCtx, testSecrets } = await import('../testing');
		const projects = await import('../domain/projects');
		const environments = await import('../domain/environments');
		const services = await import('../domain/services');
		const variables = await import('../domain/variables');
		const changes = await import('../domain/changes');
		const { redactorFor } = await import('./redact');

		const ctx = seedCtx();
		const project = projects.create(ctx, { name: 'Logs' });
		const [env] = environments.list(ctx, project.id);
		const svc = services.create(ctx, {
			projectId: project.id,
			kind: 'image',
			source: { type: 'image', image: 'nginx' }
		});
		variables.stage(ctx, {
			environmentId: env!.id,
			serviceId: svc.id,
			set: { PLAN: 'enterprise-gold' },
			unset: []
		});
		variables.stage(ctx, {
			environmentId: env!.id,
			serviceId: svc.id,
			set: {},
			unset: [],
			seal: ['PLAN']
		});
		const [dep] = changes.deploy(ctx, env!.id);

		expect(redactorFor(ctx.db, testSecrets, dep!.id)('plan is enterprise-gold')).toBe(
			'plan is [redacted:PLAN]'
		);
		expect(redactorFor(ctx.db, testSecrets, 'dep_missing')('untouched')).toBe('untouched');
	});
});
