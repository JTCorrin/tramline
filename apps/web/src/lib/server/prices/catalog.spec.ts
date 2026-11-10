import { AdapterError, fakeAdapter, FAKE_TOKEN, type Offer } from '@tramline/adapter-sdk';
import type { AgentHello } from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerAdapter } from '../adapters/registry';
import { nodePool, priceOffer, priceRegion } from '../db/schema';
import * as adapters from '../domain/adapters';
import { ensureLocalNode, recordHello, recordReport } from '../nodes/registry';
import { grantInstallAdmin, seedCtx, testSecrets } from '../testing';
import { placement, syncPrices } from './catalog';

const HOUR = 3600_000;

const size = (id: string, region: string, overrides: Partial<Offer> = {}): Offer => ({
	id,
	region,
	name: id,
	vcpus: 2,
	memoryMb: 4096,
	diskGb: 40,
	arch: 'amd64',
	gpu: null,
	hourly: 0.05,
	spotHourly: null,
	egressPerGb: 0.09,
	...overrides
});

// what each region lists, and regions whose prices can't be fetched; reset per test
let catalog: Record<string, Offer[]> = {};
let failing = new Set<string>();
let calls: string[] = [];
const fake = fakeAdapter();
type Creds = Parameters<typeof fake.adapter.validate>[0];
registerAdapter({
	...fake.adapter,
	meta: { ...fake.adapter.meta, id: 'fake-prices' },
	listOffers: async (_creds: Creds, region: string) => {
		calls.push(region);
		if (failing.has(region)) throw new AdapterError(`${region} is down`);
		return catalog[region] ?? [];
	}
} as never);

beforeEach(() => {
	catalog = {
		'eu-1': [
			size('small', 'eu-1', { hourly: 0.02, spotHourly: 0.006 }),
			size('big', 'eu-1', { vcpus: 8, memoryMb: 32_768, hourly: 0.3 }),
			size('arm', 'eu-1', { arch: 'arm64', hourly: 0.015 }),
			size('owned', 'eu-1', { hourly: null })
		],
		'us-1': [
			size('small', 'us-1', { hourly: 0.03 }),
			size('gpu', 'us-1', {
				vcpus: 8,
				memoryMb: 65_536,
				gpu: { model: 'NVIDIA L4', count: 1, vramGb: 24 },
				hourly: 0.8
			})
		]
	};
	failing = new Set();
	calls = [];
});

const hello = (memoryMb: number, cpus = 2): AgentHello => ({
	protocol: 1,
	agentVersion: 'test',
	hostname: 'box',
	os: 'linux',
	arch: 'x64',
	cpus,
	memoryMb,
	docker: { version: '27.0.0' }
});

function setup(localMemoryMb = 1024) {
	const ctx = grantInstallAdmin(seedCtx());
	ctx.settings = { ...ctx.settings, dataDir: mkdtempSync(path.join(tmpdir(), 'tramline-prices-')) };
	const { node: local } = ensureLocalNode(ctx.db, ctx.settings.dataDir);
	recordHello(ctx.db, local.id, hello(localMemoryMb));
	recordReport(ctx.db, local.id, { containers: [], revision: null });
	const account = adapters.createAccount(ctx, {
		adapter: 'fake-prices',
		name: 'Cloud',
		credentials: { apiToken: FAKE_TOKEN, project: 'p' }
	});
	return { ctx, account, local };
}

describe('comparing where a workload could run', () => {
	it('puts nodes with room first, then sizes that fit, cheapest first and unpriced last', async () => {
		const { ctx, account, local } = setup(8192);
		const result = await placement(ctx, {
			vcpus: 2,
			memoryMb: 2048,
			regions: [
				{ account: account.id, region: 'eu-1' },
				{ account: account.id, region: 'us-1' }
			]
		});
		expect(result.existing).toEqual([
			{ nodeId: local.id, name: 'local', freeCpus: 2, freeMemoryMb: 8192, freeGpus: 0 }
		]);
		expect(result.offers.map((o) => `${o.offer.region}/${o.offer.id}`)).toEqual([
			'eu-1/arm',
			'eu-1/small',
			'us-1/small',
			'eu-1/big',
			'us-1/gpu',
			'eu-1/owned'
		]);
		expect(result.offers[1]).toMatchObject({
			account: { id: account.id, name: 'Cloud', adapter: 'fake-prices' },
			hourly: 0.02,
			monthly: 14.6,
			spot: false
		});
		expect(result.offers.at(-1)).toMatchObject({ hourly: null, monthly: null });
		expect(result.regions.map((r) => [r.region, r.error])).toEqual([
			['eu-1', null],
			['us-1', null]
		]);
	});

	it('filters by architecture, size and GPUs, and ranks by spot when asked', async () => {
		const { ctx, account } = setup();
		const regions = [
			{ account: account.id, region: 'eu-1' },
			{ account: account.id, region: 'us-1' }
		];
		const ids = async (input: object) =>
			(await placement(ctx, { vcpus: 1, memoryMb: 1024, regions, ...input })).offers.map(
				(o) => `${o.offer.region}/${o.offer.id}`
			);
		expect(await ids({ arch: 'arm64' })).toEqual(['eu-1/arm']);
		expect(await ids({ vcpus: 4, memoryMb: 16_384 })).toEqual(['eu-1/big', 'us-1/gpu']);
		expect(await ids({ gpus: { count: 1, model: 'L4', minVramGb: 16 } })).toEqual(['us-1/gpu']);
		expect(await ids({ gpus: { count: 1, model: 'H100', minVramGb: null } })).toEqual([]);
		// spot moves the small eu-1 size below the arm one, which has no spot price
		const spot = await placement(ctx, {
			vcpus: 1,
			memoryMb: 1024,
			arch: 'amd64',
			spot: true,
			regions
		});
		expect(spot.offers[0]).toMatchObject({
			offer: { id: 'small', region: 'eu-1' },
			hourly: 0.006,
			spot: true
		});
		expect(spot.offers[1]).toMatchObject({ offer: { id: 'small', region: 'us-1' }, spot: false });
		// the local node has exactly the 1 GB asked for; a GPU it hasn't got rules it out
		expect(spot.existing.map((n) => n.name)).toEqual(['local']);
		const gpu = await placement(ctx, {
			vcpus: 1,
			memoryMb: 1024,
			gpus: { count: 1, model: null, minVramGb: null }
		});
		expect(gpu.existing).toEqual([]);
	});

	it('adds what the traffic out costs at each provider, and ranks by the total', async () => {
		const { ctx, account } = setup();
		catalog['us-1']![0] = size('small', 'us-1', { hourly: 0.03, egressPerGb: 0.01 });
		catalog['eu-1']![2] = size('arm', 'eu-1', { arch: 'arm64', hourly: 0.015, egressPerGb: null });
		const regions = [
			{ account: account.id, region: 'eu-1' },
			{ account: account.id, region: 'us-1' }
		];
		const result = await placement(ctx, { vcpus: 1, memoryMb: 1024, egressGb: 1000, regions });
		const row = (id: string) => result.offers.find((o) => `${o.offer.region}/${o.offer.id}` === id);
		// $21.90 a month for the machine and $10 for a TB beats $14.60 and $90
		expect(row('us-1/small')).toMatchObject({ monthly: 31.9, egress: 10 });
		expect(row('eu-1/small')).toMatchObject({ monthly: 104.6, egress: 90 });
		expect(result.offers.findIndex((o) => o === row('us-1/small'))).toBeLessThan(
			result.offers.findIndex((o) => o === row('eu-1/small'))
		);
		// a provider that doesn't say what traffic costs: the machine alone, flagged
		expect(row('eu-1/arm')).toMatchObject({ monthly: 10.95, egress: null });
		// no traffic asked about costs nothing
		const quiet = await placement(ctx, { vcpus: 1, memoryMb: 1024, regions });
		expect(quiet.offers.find((o) => o.offer.id === 'arm')).toMatchObject({ egress: 0 });
	});

	it('prices a region once a day, and shows a region that fails without hiding the rest', async () => {
		const { ctx, account } = setup();
		failing.add('us-1');
		const regions = [
			{ account: account.id, region: 'eu-1' },
			{ account: account.id, region: 'us-1' }
		];
		const first = await placement(ctx, { vcpus: 1, memoryMb: 1024, regions });
		expect(first.offers.every((o) => o.offer.region === 'eu-1')).toBe(true);
		expect(first.regions.find((r) => r.region === 'us-1')).toMatchObject({
			fetchedAt: null,
			error: 'Cloud: us-1 is down'
		});
		expect(calls).toEqual(['eu-1', 'us-1']);

		// eu-1 is fresh, so only us-1 is asked again; once it works its error goes
		failing.clear();
		const second = await placement(ctx, { vcpus: 1, memoryMb: 1024, regions });
		expect(calls).toEqual(['eu-1', 'us-1', 'us-1']);
		expect(second.regions.find((r) => r.region === 'us-1')?.error).toBeNull();
		// with no regions given, whatever has been kept still compares
		expect((await placement(ctx, { vcpus: 1, memoryMb: 1024 })).offers).toHaveLength(6);
	});

	it('is for install admins only', async () => {
		const { ctx } = setup();
		await expect(
			placement({ ...ctx, userId: 'someone-else' } as never, { vcpus: 1, memoryMb: 1024 })
		).rejects.toThrow();
	});
});

describe('keeping prices fresh', () => {
	it('refreshes the regions pools use and ones compared lately, a day apart', async () => {
		const { ctx, account } = setup();
		ctx.db
			.insert(nodePool)
			.values({
				id: 'pool_1',
				name: 'web',
				adapterAccountId: account.id,
				region: 'us-1',
				offer: 'small',
				offerName: 'small',
				vcpus: 2,
				memoryMb: 4096,
				maxNodes: 1,
				origin: 'http://tramline.test'
			})
			.run();
		const now = Date.now();
		expect(await syncPrices(ctx.db, testSecrets, new Date(now))).toBe(1);
		expect(calls).toEqual(['us-1']);
		// nothing is due an hour later
		expect(await syncPrices(ctx.db, testSecrets, new Date(now + HOUR))).toBe(0);
		// a day later it's refreshed again
		expect(await syncPrices(ctx.db, testSecrets, new Date(now + 25 * HOUR))).toBe(1);
		expect(calls).toEqual(['us-1', 'us-1']);
	});

	it('retries a failed region after an hour, and forgets regions nobody uses', async () => {
		const { ctx, account } = setup();
		const now = Date.now();
		await placement(
			ctx,
			{ vcpus: 1, memoryMb: 1024, regions: [{ account: account.id, region: 'eu-1' }] },
			new Date(now)
		);
		failing.add('eu-1');
		expect(await syncPrices(ctx.db, testSecrets, new Date(now + 25 * HOUR))).toBe(0);
		const region = () =>
			ctx.db.select().from(priceRegion).where(eq(priceRegion.region, 'eu-1')).get();
		expect(region()?.error).toBe('Cloud: eu-1 is down');
		// the old prices stay until a refresh works
		expect(ctx.db.select().from(priceOffer).all()).toHaveLength(4);
		calls = [];
		await syncPrices(ctx.db, testSecrets, new Date(now + 25.5 * HOUR));
		expect(calls).toEqual([]);
		failing.clear();
		expect(await syncPrices(ctx.db, testSecrets, new Date(now + 26.5 * HOUR))).toBe(1);
		expect(region()?.error).toBeNull();

		// a month after anyone compared it, it and its prices go
		await syncPrices(ctx.db, testSecrets, new Date(now + 31 * 24 * HOUR));
		expect(region()).toBeUndefined();
		expect(ctx.db.select().from(priceOffer).all()).toHaveLength(0);
	});

	it('goes with its account', async () => {
		const { ctx, account } = setup();
		await placement(ctx, {
			vcpus: 1,
			memoryMb: 1024,
			regions: [{ account: account.id, region: 'eu-1' }]
		});
		adapters.removeAccount(ctx, account.id);
		expect(ctx.db.select().from(priceOffer).all()).toHaveLength(0);
		expect(ctx.db.select().from(priceRegion).all()).toHaveLength(0);
	});
});
