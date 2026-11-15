import { describe, expect, it } from 'vitest';
import { dollars, FAILURE_TTL_MS, parseRates, RATES_TTL_MS, RATES_URL } from './currency';

const XML = `<Cube time='2026-11-10'><Cube currency='USD' rate='1.0861'/><Cube currency="GBP" rate="0.8412"/><Cube currency='BAD' rate='-1'/></Cube>`;

describe('ECB rates', () => {
	it('reads each currency per euro, with the euro itself', () => {
		expect(parseRates(XML)).toEqual(
			new Map([
				['EUR', 1],
				['USD', 1.0861],
				['GBP', 0.8412]
			])
		);
	});

	it('converts to dollars, fetching once a day, and again ten minutes after a failure', async () => {
		let t = 0;
		let up = false;
		const urls: string[] = [];
		const toUsd = dollars({
			now: () => t,
			fetch: (async (input: string) => {
				urls.push(input);
				return up ? new Response(XML) : new Response('', { status: 500 });
			}) as unknown as typeof fetch
		});
		expect(await toUsd('USD')).toBe(1);
		expect(urls).toEqual([]);
		expect(await toUsd('EUR')).toBeNull();
		up = true;
		t += FAILURE_TTL_MS - 1;
		expect(await toUsd('EUR')).toBeNull();
		t += 1;
		expect(await toUsd('eur')).toBe(1.0861);
		expect(await toUsd('GBP')).toBeCloseTo(1.0861 / 0.8412, 10);
		t += RATES_TTL_MS - 1;
		await toUsd('EUR');
		expect(urls).toEqual([RATES_URL, RATES_URL]);
		t += 1;
		await toUsd('EUR');
		expect(urls).toHaveLength(3);
	});

	it('has no rate when the ECB is unreachable or its page has no dollar rate', async () => {
		const unreachable = dollars({
			fetch: (async () => {
				throw new TypeError('fetch failed');
			}) as unknown as typeof fetch
		});
		expect(await unreachable('EUR')).toBeNull();
		const noDollar = dollars({
			fetch: (async () =>
				new Response("<Cube currency='GBP' rate='0.84'/>")) as unknown as typeof fetch
		});
		expect(await noDollar('EUR')).toBeNull();
	});
});
