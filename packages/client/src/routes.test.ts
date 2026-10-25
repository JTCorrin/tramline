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
	['github.status', (c) => c.github.status(), 'GET /github'],
	['github.manifest', (c) => c.github.manifest('acme'), 'POST /github/manifest'],
	['github.repos', (c) => c.github.repos(), 'GET /github/repos'],
	['github.disconnect', (c) => c.github.disconnect('42'), 'DELETE /github/installations/42'],
	['deployments.runs', (c) => c.deployments.runs('dep_1'), 'GET /deployments/dep_1/runs'],
	['deployments.runNow', (c) => c.deployments.runNow('dep_1'), 'POST /deployments/dep_1/runs'],
	['backups.storage', (c) => c.backups.storage(), 'GET /backup-storage'],
	[
		'backups.saveStorage',
		(c) =>
			c.backups.saveStorage({
				endpoint: 'https://s3.example.com',
				bucket: 'b',
				accessKeyId: 'k',
				secretAccessKey: 's'
			}),
		'PUT /backup-storage'
	],
	['backups.removeStorage', (c) => c.backups.removeStorage(), 'DELETE /backup-storage'],
	['backups.testStorage', (c) => c.backups.testStorage(), 'POST /backup-storage/test'],
	[
		'backups.volumes',
		(c) => c.backups.volumes({ serviceId: 's', environmentId: 'e' }),
		'GET /volumes?serviceId=s&environmentId=e'
	],
	[
		'backups.updateVolume',
		(c) => c.backups.updateVolume('vol_1', { backupSchedule: 'daily' }),
		'PATCH /volumes/vol_1'
	],
	['backups.getAll', (c) => c.backups.getAll({ volumeId: 'vol_1' }), 'GET /backups?volumeId=vol_1'],
	['backups.create', (c) => c.backups.create('vol_1'), 'POST /backups'],
	['backups.remove', (c) => c.backups.remove('bak_1'), 'DELETE /backups/bak_1'],
	['backups.restore', (c) => c.backups.restore('bak_1'), 'POST /backups/bak_1/restore'],
	['backups.verify', (c) => c.backups.verify('bak_1'), 'POST /backups/bak_1/verify'],
	[
		'domains.getAll',
		(c) => c.domains.getAll({ serviceId: 's', environmentId: 'e' }),
		'GET /domains?serviceId=s&environmentId=e'
	],
	[
		'domains.create',
		(c) => c.domains.create({ serviceId: 's', environmentId: 'e', hostname: 'app.example.com' }),
		'POST /domains'
	],
	[
		'data.tables',
		(c) => c.data.tables({ serviceId: 's', environmentId: 'e' }),
		'GET /data/tables?serviceId=s&environmentId=e'
	],
	[
		'data.rows',
		(c) => c.data.rows({ serviceId: 's', environmentId: 'e', schema: 'public', table: 'notes' }),
		'GET /data/rows?serviceId=s&environmentId=e&schema=public&table=notes&offset=0'
	],
	[
		'deployments.logs',
		(c) => c.deployments.logs('dep_1', 50),
		'GET /deployments/dep_1/logs?format=json&tail=50'
	],
	['tokens.getAll', (c) => c.tokens.getAll(), 'GET /tokens'],
	[
		'tokens.create',
		(c) => c.tokens.create({ name: 'ci', scopes: ['deploy'], expiresInDays: 30 }),
		'POST /tokens'
	],
	['tokens.revoke', (c) => c.tokens.revoke('tok_1'), 'DELETE /tokens/tok_1'],
	['tokens.auditLog', (c) => c.tokens.auditLog(), 'GET /audit-log'],
	['domains.remove', (c) => c.domains.remove('dom_1'), 'DELETE /domains/dom_1'],
	['domains.verify', (c) => c.domains.verify('dom_1'), 'POST /domains/dom_1/verify'],
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
