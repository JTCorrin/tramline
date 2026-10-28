import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	AdapterError,
	cloudInit,
	conformance,
	credentialFields,
	defineAdapter,
	fakeAdapter,
	FAKE_TOKEN,
	mergeCredentials,
	publicCredentials,
	type ComputeAdapter
} from './index';

const good = { apiToken: FAKE_TOKEN, project: 'default' };

describe('the fake adapter', () => {
	it('passes the conformance suite, enrollment included', async () => {
		const { adapter, machines } = fakeAdapter();
		let enrolled = '';
		const steps = await conformance(adapter, {
			credentials: good,
			invalidCredentials: { apiToken: 'wrong', project: 'default' },
			enrolled: async (spec) => {
				enrolled = spec.name;
			},
			pollMs: 1
		});
		expect(steps).toContain('no orphans');
		expect(steps).toContain('the machine enrolled');
		expect(enrolled).toMatch(/^conformance-/);
		expect(machines.size).toBe(0);
	});

	it('refuses bad tokens and unknown sizes with messages a person can act on', async () => {
		const { adapter } = fakeAdapter();
		await expect(adapter.validate({ apiToken: 'nope', project: 'p' })).rejects.toThrow(
			AdapterError
		);
		await expect(
			adapter.createNode(good, {
				name: 'n',
				region: 'fake-1',
				offer: 'huge',
				install: { url: 'u', token: 't', command: 'c' },
				userData: ''
			})
		).rejects.toThrow('No size huge in fake-1');
		expect(await adapter.listOffers(good, 'elsewhere')).toEqual([]);
	});
});

/** The fake, with one part broken. */
function broken(patch: Partial<ComputeAdapter<typeof good>>) {
	const { adapter } = fakeAdapter();
	return defineAdapter({ ...adapter, ...patch });
}

describe('the conformance suite', () => {
	it('catches a machine that outlives destroyNode', async () => {
		const adapter = broken({ destroyNode: async () => {} });
		await expect(
			conformance(adapter, { credentials: good, goneWithinMs: 5, pollMs: 1 })
		).rejects.toThrow('still there after destroyNode (an orphan)');
	});

	it('catches offers that break the contract', async () => {
		const gpuless = { ...fakeAdapter().adapter.capabilities, gpus: false };
		await expect(
			conformance(broken({ capabilities: gpuless }), { credentials: good })
		).rejects.toThrow('capabilities.gpus is false');
		await expect(
			conformance(broken({ listOffers: async () => [{ id: 'x' }] as never }), { credentials: good })
		).rejects.toThrow("listOffers doesn't match the contract");
	});

	it('catches validate accepting anything, and lost machines', async () => {
		await expect(
			conformance(broken({ validate: async () => {} }), {
				credentials: good,
				invalidCredentials: { apiToken: 'x', project: 'p' }
			})
		).rejects.toThrow('validate accepted the invalid credentials');
		const { adapter, machines } = fakeAdapter();
		await expect(
			conformance(defineAdapter({ ...adapter, getNode: async () => null }), { credentials: good })
		).rejects.toThrow('getNode lost it');
		// the machine it created is destroyed even though a check failed
		expect(machines.size).toBe(0);
	});

	it('checks regions, ids and the instructions of adapters that cannot provision', async () => {
		await expect(
			conformance(broken({ listRegions: async () => [] }), { credentials: good })
		).rejects.toThrow('no regions');
		await expect(
			conformance(fakeAdapter().adapter, { credentials: good, region: 'mars' })
		).rejects.toThrow("Region mars isn't among");
		const { adapter } = fakeAdapter();
		await expect(
			conformance(defineAdapter({ ...adapter, meta: { ...adapter.meta, id: 'Fake' } }), {
				credentials: good
			})
		).rejects.toThrow('must be lowercase');
		const noAuto = { ...adapter.capabilities, autoProvision: false };
		await expect(
			conformance(broken({ capabilities: noAuto }), { credentials: good })
		).rejects.toThrow('must say what to do instead');
	});
});

describe('credential forms', () => {
	const schema = z.object({
		apiToken: z.string().min(1).meta({ title: 'API token', secret: true }),
		endpoint: z.string().url().meta({ placeholder: 'https://pve.lan:8006' }),
		verifyTls: z.boolean().default(true),
		port: z.number().int().optional(),
		tier: z.enum(['basic', 'pro'])
	});

	it('describes each field for a generated form', () => {
		expect(credentialFields(schema)).toEqual([
			expect.objectContaining({
				key: 'apiToken',
				label: 'API token',
				secret: true,
				required: true
			}),
			expect.objectContaining({
				key: 'endpoint',
				label: 'Endpoint',
				placeholder: 'https://pve.lan:8006'
			}),
			expect.objectContaining({
				key: 'verifyTls',
				type: 'boolean',
				default: true,
				required: false
			}),
			expect.objectContaining({ key: 'port', type: 'number', required: false }),
			expect.objectContaining({ key: 'tier', type: 'enum', options: ['basic', 'pro'] })
		]);
		expect(() => credentialFields(z.string())).toThrow('object schema');
	});

	it('never shows secrets, and keeps a saved one left blank', () => {
		const saved = { apiToken: 'secret', endpoint: 'https://a.test', verifyTls: true, tier: 'pro' };
		expect(publicCredentials(schema, saved)).toEqual({
			endpoint: 'https://a.test',
			verifyTls: true,
			tier: 'pro'
		});
		expect(
			mergeCredentials(
				schema,
				{ apiToken: '', endpoint: 'https://b.test', tier: 'pro', port: '' },
				saved
			)
		).toEqual({ apiToken: 'secret', endpoint: 'https://b.test', verifyTls: true, tier: 'pro' });
		expect(() =>
			mergeCredentials(schema, { endpoint: 'https://b.test', tier: 'pro' }, null)
		).toThrow();
	});
});

describe('cloud-init', () => {
	it('installs Docker when missing, then enrolls with the token, quoted', () => {
		const data = cloudInit({ url: 'https://t.test', token: "tljoin_a'b" });
		expect(data.startsWith('#cloud-config\n')).toBe(true);
		expect(data).toContain('apt-get install -yq docker.io curl');
		expect(data).toContain(`--token 'tljoin_a'"'"'b'`);
		expect(data).toContain('runcmd:\n  - [sh, /run/tramline-enroll.sh]');
	});
});
