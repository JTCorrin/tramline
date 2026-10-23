import { describe, expect, it, vi } from 'vitest';
import { createClient, type TramlineClient } from './index';

/** Every client method and the request it must produce. */
const ROUTES: [string, (c: TramlineClient) => Promise<unknown>, string][] = [
	['projects.getAll', (c) => c.projects.getAll(), 'GET /projects'],
	[
		'environments.getAll',
		(c) => c.environments.getAll({ projectId: 'p' }),
		'GET /environments?projectId=p'
	],
	['environments.get', (c) => c.environments.get('e'), 'GET /environments/e'],
	[
		'environments.create',
		(c) => c.environments.create({ projectId: 'p', name: 'staging' }),
		'POST /environments'
	],
	[
		'environments.update',
		(c) => c.environments.update('e', { name: 'qa' }),
		'PATCH /environments/e'
	],
	['environments.remove', (c) => c.environments.remove('e'), 'DELETE /environments/e'],
	['environments.canvas', (c) => c.environments.canvas('e'), 'GET /environments/e/canvas'],
	['environments.changes', (c) => c.environments.changes('e'), 'GET /environments/e/changes'],
	['environments.discard', (c) => c.environments.discard('e'), 'DELETE /environments/e/changes'],
	['environments.deploy', (c) => c.environments.deploy('e'), 'POST /environments/e/deploy'],
	['services.get', (c) => c.services.get('s'), 'GET /services/s'],
	[
		'services.create',
		(c) => c.services.create({ projectId: 'p', kind: 'empty' }),
		'POST /services'
	],
	['services.update', (c) => c.services.update('s', { name: 'api' }), 'PATCH /services/s'],
	['services.remove', (c) => c.services.remove('s'), 'DELETE /services/s'],
	['services.config', (c) => c.services.config('s', 'e'), 'GET /services/s/config?environmentId=e'],
	[
		'variables.getAll (service)',
		(c) => c.variables.getAll({ environmentId: 'e', serviceId: 's' }),
		'GET /variables?environmentId=e&serviceId=s'
	],
	[
		'variables.stage',
		(c) => c.variables.stage({ environmentId: 'e', set: { A: '1' } }),
		'PATCH /variables'
	],
	['deployments.get', (c) => c.deployments.get('d'), 'GET /deployments/d'],
	['deployments.redeploy', (c) => c.deployments.redeploy('d'), 'POST /deployments/d/redeploy'],
	['deployments.remove', (c) => c.deployments.remove('d'), 'POST /deployments/d/remove'],
	['nodes.getAll', (c) => c.nodes.getAll(), 'GET /nodes'],
	[
		'deployments.getAll',
		(c) => c.deployments.getAll({ serviceId: 's', environmentId: 'e' }),
		'GET /deployments?serviceId=s&environmentId=e'
	]
];

describe('client routes', () => {
	it.each(ROUTES)('%s', async (_, call, expected) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}));
		await call(createClient({ baseUrl: '/api/v1', fetch }));
		const [url, init] = fetch.mock.calls[0]!;
		expect(`${init?.method} ${url}`).toBe(expected.replace(' /', ' /api/v1/'));
	});

	it('exposes the logs stream path', () => {
		expect(createClient({ baseUrl: '/api/v1' }).deployments.logsPath('d')).toBe(
			'/deployments/d/logs'
		);
	});

	it('uses the global fetch when none is passed', async () => {
		const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([]));
		await createClient({ baseUrl: '/api/v1' }).projects.getAll();
		expect(spy).toHaveBeenCalledOnce();
		spy.mockRestore();
	});
});
