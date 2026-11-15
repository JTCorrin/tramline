/**
 * Hetzner prices in the currency of the project owner's account, euros for
 * most. Offer prices are US dollars, so they're converted at the European
 * Central Bank's daily reference rates: public, no sign-in, euros to about
 * thirty currencies. The rates are cached for a day, and a failure for ten
 * minutes; when there's no rate, sizes come back without prices rather than
 * with euros passed off as dollars.
 */

export const RATES_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
export const RATES_TTL_MS = 24 * 60 * 60_000;
export const FAILURE_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 15_000;

export interface RateOptions {
	fetch?: typeof fetch;
	/** The clock the cache uses; tests move it. */
	now?: () => number;
}

/** Units of each currency per euro, as the ECB publishes them, with the euro itself. */
type Rates = Map<string, number>;

/** Each currency's rate in the ECB's XML: `<Cube currency='USD' rate='1.0861'/>`. */
export function parseRates(xml: string): Rates {
	const rates: Rates = new Map([['EUR', 1]]);
	for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g)) {
		const rate = Number(m[2]);
		if (Number.isFinite(rate) && rate > 0) rates.set(m[1]!, rate);
	}
	return rates;
}

/** A converter from any currency the ECB lists to US dollars, sharing one cache. */
export function dollars(options: RateOptions = {}) {
	const now = options.now ?? Date.now;
	let cached: { rates: Rates | null; until: number } | null = null;
	let pending: Promise<Rates | null> | null = null;

	async function load(): Promise<Rates | null> {
		try {
			const response = await (options.fetch ?? fetch)(RATES_URL, {
				signal: AbortSignal.timeout(TIMEOUT_MS)
			});
			if (!response.ok) return null;
			const rates = parseRates(await response.text());
			return rates.has('USD') ? rates : null;
		} catch {
			return null;
		}
	}

	async function rates() {
		if (cached && now() < cached.until) return cached.rates;
		pending ??= load().then((r) => {
			cached = { rates: r, until: now() + (r ? RATES_TTL_MS : FAILURE_TTL_MS) };
			pending = null;
			return r;
		});
		return pending;
	}

	/** US dollars per unit of `currency`, or null when there's no rate for it. */
	return async function perUnit(currency: string): Promise<number | null> {
		const code = currency.toUpperCase();
		if (code === 'USD') return 1;
		const r = await rates();
		const from = r?.get(code);
		const usd = r?.get('USD');
		return from && usd ? usd / from : null;
	};
}
