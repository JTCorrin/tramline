import { DATABASE_ENGINES } from '@tramline/contracts';
import { describe, expect, it } from 'vitest';
import { builtinVariables, resolveVariables } from './resolve';
import { DATABASE_TEMPLATES } from './templates';

describe.each(DATABASE_ENGINES)('%s template', (engine) => {
	const template = DATABASE_TEMPLATES[engine];

	it('has an image, a port and a fresh password per call', () => {
		expect(template.config.source?.type).toBe('image');
		expect(template.config.networking.port).toBeGreaterThan(0);
		expect(template.variables()).not.toEqual(template.variables());
	});

	it('resolves every reference it uses', () => {
		const service = { id: 'svc_db', name: template.name };
		const { variables, missing } = resolveVariables({
			shared: {},
			services: [
				{
					...service,
					variables: template.variables(),
					builtins: builtinVariables(service, { id: 'env_1', name: 'production' }, 1)
				}
			]
		});
		expect(missing).toEqual([]);
		const url = Object.entries(variables.get('svc_db')!).find(([key]) => key.endsWith('_URL'))![1];
		expect(url).toContain(`${template.name.toLowerCase()}.production.tramline.internal`);
		expect(url).not.toContain('${{');
	});
});
