import { describe, expect, it } from 'vitest';
import { referencedServices, resolveVariables } from './resolve';

const svc = (name: string, variables: Record<string, string>, builtins = {}) => ({
	id: `id_${name}`,
	name,
	variables,
	builtins
});

describe('resolveVariables', () => {
	it('resolves self, shared, cross-service and builtin references', () => {
		const { variables, missing } = resolveVariables({
			shared: { REGION: 'eu' },
			services: [
				svc(
					'Postgres',
					{ USER: 'pg', URL: 'postgres://${{USER}}@${{ TRAMLINE_PRIVATE_DOMAIN }}' },
					{ TRAMLINE_PRIVATE_DOMAIN: 'postgres.production.tramline.internal' }
				),
				svc('api', { DATABASE_URL: '${{Postgres.URL}}', AREA: '${{shared.REGION}}-1' })
			]
		});

		expect(variables.get('id_api')).toEqual({
			DATABASE_URL: 'postgres://pg@postgres.production.tramline.internal',
			AREA: 'eu-1'
		});
		expect(variables.get('id_Postgres')).toMatchObject({
			URL: 'postgres://pg@postgres.production.tramline.internal'
		});
		expect(missing).toEqual([]);
	});

	it('turns unknown references into empty strings and reports them', () => {
		const { variables, missing } = resolveVariables({
			shared: {},
			services: [svc('api', { URL: 'x${{Redis.URL}}y' })]
		});
		expect(variables.get('id_api')).toEqual({ URL: 'xy' });
		expect(missing).toEqual([{ serviceId: 'id_api', key: 'URL', reference: 'Redis.URL' }]);
	});

	it('rejects reference cycles with the loop in the message', () => {
		expect(() =>
			resolveVariables({
				shared: {},
				services: [svc('a', { X: '${{b.Y}}' }), svc('b', { Y: '${{a.X}}' })]
			})
		).toThrowError(/loop: a\.X → b\.Y → a\.X/);
	});
});

describe('referencedServices', () => {
	it('lists other services, ignoring self and shared', () => {
		expect(
			referencedServices(
				{ A: '${{Postgres.URL}} ${{Redis.URL}}', B: '${{shared.X}} ${{api.Y}} ${{Z}}' },
				'api'
			)
		).toEqual(new Set(['Postgres', 'Redis']));
	});
});
