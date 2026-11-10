import { z } from 'zod';

/**
 * VM prices from the Azure Retail Prices API, which is public (no sign-in).
 * Prices are retail, in US dollars, for Linux, per hour. A size gets an
 * on-demand price (the plain meter) and a spot price (the meter whose
 * skuName ends in " Spot"). Windows, Low Priority, Cloud Services,
 * reservation and Dev/Test prices are left out.
 *
 * Prices never break listing sizes: when the API fails, is slow or returns
 * something unexpected, sizes come back without prices. Price tables are
 * cached per region for a day, and a failure for ten minutes, so a form
 * that lists offers over and over doesn't hammer the API.
 */

export const PRICES_API = 'https://prices.azure.com/api/retail/prices';
const PRICES_API_VERSION = '2023-01-01-preview';

/**
 * Internet egress per GB, after the first 100 GB a month that are free:
 * Azure's first tier (up to 10 TB) for Zone 1 (North America and Europe),
 * routed over Microsoft's network, which is the default. From the Azure
 * bandwidth pricing page (azure.microsoft.com/pricing/details/bandwidth),
 * and the Retail Prices API's "Standard Data Transfer Out" meter for
 * eastus agreed; checked 2026-11-10. Other zones cost more (Zone 2, most of
 * Asia, is about $0.12), so this is a floor outside Zone 1.
 */
export const EGRESS_PER_GB = 0.087;

export const PRICE_TTL_MS = 24 * 60 * 60_000;
export const FAILURE_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 20_000;
/** A region has about ten pages of 1,000; more than this is a loop. */
const MAX_PAGES = 50;

export interface SizePrice {
	hourly: number | null;
	spotHourly: number | null;
}

/** Prices by ARM size name (`Standard_D2s_v5`). */
export type PriceTable = Map<string, SizePrice>;

export interface PriceOptions {
	fetch?: typeof fetch;
	/** The clock the cache uses; tests move it. */
	now?: () => number;
	priceTimeoutMs?: number;
}

const Page = z.object({
	Items: z.array(z.unknown()),
	NextPageLink: z.string().nullish()
});

const Item = z.object({
	armSkuName: z.string().min(1),
	skuName: z.string(),
	productName: z.string(),
	retailPrice: z.number().nonnegative().finite(),
	unitOfMeasure: z.string(),
	type: z.string(),
	currencyCode: z.string(),
	effectiveStartDate: z.string().optional()
});
type Item = z.infer<typeof Item>;

/** The OData filter for a region's Linux and Windows VM prices; the rest is sorted out here. */
export function priceFilter(region: string) {
	const quoted = `'${region.replace(/'/g, "''")}'`;
	return `serviceName eq 'Virtual Machines' and armRegionName eq ${quoted} and priceType eq 'Consumption'`;
}

/** Whether an item is a meter Tramline uses, and which one: on-demand or spot. */
function kind(item: Item): keyof SizePrice | null {
	if (item.type !== 'Consumption' || item.currencyCode !== 'USD') return null;
	if (item.unitOfMeasure !== '1 Hour') return null;
	// Windows prices include the licence; Cloud Services are a different product at a higher price
	if (/Windows|Cloud ?Services/i.test(item.productName)) return null;
	if (/Low Priority$/.test(item.skuName)) return null;
	return / Spot$/.test(item.skuName) ? 'spotHourly' : 'hourly';
}

/** Builds a size's prices from the API's items; the latest one wins if a meter repeats. */
export function priceTable(items: unknown[]): PriceTable {
	const table: PriceTable = new Map();
	const started = new Map<string, string>();
	for (const raw of items) {
		const parsed = Item.safeParse(raw);
		if (!parsed.success) continue;
		const item = parsed.data;
		const which = kind(item);
		if (!which) continue;
		const key = `${item.armSkuName}\n${which}`;
		const start = item.effectiveStartDate ?? '';
		if (started.has(key) && started.get(key)! > start) continue;
		started.set(key, start);
		const entry = table.get(item.armSkuName) ?? { hourly: null, spotHourly: null };
		entry[which] = item.retailPrice;
		table.set(item.armSkuName, entry);
	}
	return table;
}

export class AzurePrices {
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #timeoutMs: number;
	readonly #cache = new Map<string, { table: Promise<PriceTable | null>; expiresAt: number }>();

	constructor(options: PriceOptions = {}) {
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#timeoutMs = options.priceTimeoutMs ?? TIMEOUT_MS;
	}

	/** A region's prices, or null when they couldn't be had. Never throws. */
	forRegion(region: string): Promise<PriceTable | null> {
		const cached = this.#cache.get(region);
		if (cached && cached.expiresAt > this.#now()) return cached.table;
		// one request per region at a time; it expires once it has finished
		const entry = { table: this.#load(region), expiresAt: Infinity };
		this.#cache.set(region, entry);
		void entry.table.then((table) => {
			entry.expiresAt = this.#now() + (table ? PRICE_TTL_MS : FAILURE_TTL_MS);
		});
		return entry.table;
	}

	async #load(region: string): Promise<PriceTable | null> {
		try {
			const items: unknown[] = [];
			const query = new URLSearchParams({
				'api-version': PRICES_API_VERSION,
				$filter: priceFilter(region)
			});
			let next: string | null | undefined = `${PRICES_API}?${query}`;
			const signal = AbortSignal.timeout(this.#timeoutMs);
			for (let pages = 0; next; pages++) {
				// the next page link comes from the response, so only follow it to the same API
				const url = new URL(next);
				if (pages >= MAX_PAGES || url.origin !== new URL(PRICES_API).origin) return null;
				const response = await this.#fetch(url.href, { signal });
				if (!response.ok) return null;
				const page = Page.safeParse(await response.json());
				if (!page.success) return null;
				items.push(...page.data.Items);
				next = page.data.NextPageLink;
			}
			const table = priceTable(items);
			// a real region always has prices; none means something is wrong, so try again soon
			return table.size ? table : null;
		} catch {
			return null;
		}
	}
}
