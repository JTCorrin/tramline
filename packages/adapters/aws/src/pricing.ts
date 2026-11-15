import { z } from 'zod';
import type { AwsClient } from './client';
import { items, text } from './xml';

/**
 * On-demand prices from the AWS Price List Query API. It only lives in a few
 * regions; us-east-1 is the one every account can call, and it answers for
 * every region. Spot prices come from EC2's DescribeSpotPriceHistory in the
 * region itself: the current price of each size in each availability zone.
 *
 * Prices are a nice-to-have: anything that goes wrong (a policy without
 * `pricing:GetProducts` or `ec2:DescribeSpotPriceHistory`, a timeout, a
 * response that doesn't parse) leaves them unknown rather than failing
 * `listOffers`.
 */

export const PRICING_URL = 'https://api.pricing.us-east-1.amazonaws.com/';
const PRICING_REGION = 'us-east-1';
const GET_PRODUCTS = 'AWSPriceListService.GetProducts';
const TIMEOUT_MS = 15_000;
/** At 100 a page this is far more than the curated sizes need; it stops a runaway NextToken. */
const MAX_PAGES = 10;

/**
 * Data transfer out from EC2 to the internet, first 10 TB a month, in $/GB:
 * the rate on https://aws.amazon.com/ec2/pricing/on-demand/ ("Data Transfer
 * OUT From Amazon EC2 To Internet") for the US and European regions. A few
 * regions (South America, parts of Asia Pacific) charge more, and the first
 * 100 GB a month across the account is free.
 */
export const EGRESS_PER_GB = 0.09;

export const PRICES_FOR_MS = 24 * 60 * 60_000;
/** Spot prices move with demand, so they're asked for again within the hour. */
export const SPOT_PRICES_FOR_MS = 60 * 60_000;
export const FAILURE_FOR_MS = 10 * 60_000;

const Page = z.object({
	PriceList: z.array(z.unknown()).default([]),
	NextToken: z.string().nullish()
});

const Product = z.object({
	product: z.object({ attributes: z.object({ instanceType: z.string() }) }),
	terms: z.object({
		OnDemand: z.record(
			z.string(),
			z.object({
				priceDimensions: z.record(
					z.string(),
					z.object({
						unit: z.string().optional(),
						pricePerUnit: z.object({ USD: z.string().optional() })
					})
				)
			})
		)
	})
});

const term = (Field: string, Value: string) => ({ Type: 'TERM_MATCH', Field, Value });

/** A PriceList entry (a JSON string) as an instance type and its hourly USD price. */
export function parseProduct(entry: unknown): { type: string; hourly: number } | null {
	let value = entry;
	if (typeof entry === 'string') {
		try {
			value = JSON.parse(entry);
		} catch {
			return null;
		}
	}
	const product = Product.safeParse(value);
	if (!product.success) return null;
	for (const offer of Object.values(product.data.terms.OnDemand)) {
		for (const dimension of Object.values(offer.priceDimensions)) {
			if (dimension.unit && !/^hrs?$/i.test(dimension.unit)) continue;
			const hourly = Number(dimension.pricePerUnit.USD);
			// no EC2 instance is free on demand; a 0 is a placeholder SKU, not a price
			if (dimension.pricePerUnit.USD && Number.isFinite(hourly) && hourly > 0) {
				return { type: product.data.product.attributes.instanceType, hourly };
			}
		}
	}
	return null;
}

/**
 * Linux on-demand prices of the given instance types in a region. One query
 * covers them all (`ANY_OF`), paged, since the curated list is a few dozen
 * sizes and the API is throttled.
 */
export async function onDemandPrices(api: AwsClient, region: string, types: string[]) {
	const prices = new Map<string, number>();
	if (!types.length) return prices;
	const wanted = new Set(types);
	const Filters = [
		term('regionCode', region),
		term('operatingSystem', 'Linux'),
		term('tenancy', 'Shared'),
		term('preInstalledSw', 'NA'),
		term('capacitystatus', 'Used'),
		term('licenseModel', 'No License required'),
		{ Type: 'ANY_OF', Field: 'instanceType', Value: types.join(',') }
	];
	let token: string | null | undefined;
	let pages = 0;
	do {
		const raw = await api.json(
			PRICING_URL,
			PRICING_REGION,
			'pricing',
			GET_PRODUCTS,
			{
				ServiceCode: 'AmazonEC2',
				Filters,
				FormatVersion: 'aws_v1',
				MaxResults: 100,
				...(token ? { NextToken: token } : {})
			},
			TIMEOUT_MS
		);
		const page = Page.parse(raw);
		for (const entry of page.PriceList) {
			const found = parseProduct(entry);
			if (found && wanted.has(found.type) && !prices.has(found.type)) {
				prices.set(found.type, found.hourly);
			}
		}
		token = page.NextToken;
	} while (token && ++pages < MAX_PAGES);
	return prices;
}

/** EC2's name for Linux in the spot price history; VPC-only accounts are priced under it too. */
export const SPOT_PRODUCT = 'Linux/UNIX';
/** 1,000 a page is a few pages for the curated sizes in every zone; it stops a runaway nextToken. */
const MAX_SPOT_PAGES = 10;

/** Spot prices by instance type, then availability zone, in $/hour. */
export type SpotPrices = Map<string, Map<string, number>>;

/**
 * The current Linux spot price of the given instance types in each of the
 * region's availability zones. A start time of now gives each size and
 * zone's latest price change, the price in effect now; should a later one
 * also come back, the latest wins.
 */
export async function spotPrices(
	api: AwsClient,
	region: string,
	types: string[],
	now: Date
): Promise<SpotPrices> {
	const prices: SpotPrices = new Map();
	if (!types.length) return prices;
	const wanted = new Set(types);
	const seen = new Map<string, string>();
	let token: string | null = null;
	let pages = 0;
	do {
		const page = await api.call(region, 'DescribeSpotPriceHistory', {
			'ProductDescription.1': SPOT_PRODUCT,
			StartTime: now.toISOString(),
			MaxResults: '1000',
			...Object.fromEntries(types.map((type, i) => [`InstanceType.${i + 1}`, type])),
			...(token ? { NextToken: token } : {})
		});
		for (const entry of items(page, 'spotPriceHistorySet')) {
			const type = text(entry, 'instanceType');
			const zone = text(entry, 'availabilityZone');
			const hourly = Number(text(entry, 'spotPrice'));
			const at = text(entry, 'timestamp') ?? '';
			if (!type || !zone || !wanted.has(type)) continue;
			if (text(entry, 'productDescription') !== SPOT_PRODUCT) continue;
			if (!Number.isFinite(hourly) || hourly <= 0) continue;
			const key = `${type} ${zone}`;
			if ((seen.get(key) ?? '') > at) continue;
			seen.set(key, at);
			const zones = prices.get(type) ?? new Map<string, number>();
			zones.set(zone, hourly);
			prices.set(type, zones);
		}
		token = text(page, 'nextToken');
	} while (token && ++pages < MAX_SPOT_PAGES);
	return prices;
}

/** A size's lowest spot price across the zones, or null when none has one. */
export function lowestSpot(prices: SpotPrices | null, type: string) {
	const zones = prices?.get(type);
	return zones?.size ? Math.min(...zones.values()) : null;
}

/**
 * Prices by region, kept in the process. List prices are the same for every
 * account, so a success is shared; a failure is usually one account's
 * policy, so it's kept per access key, and for less time. Spot prices are
 * kept per account (`shared: false`): zone names like us-east-1a map to
 * different zones in different accounts.
 */
export class PriceCache<T = Map<string, number>> {
	readonly #ok = new Map<string, { at: number; prices: T }>();
	readonly #failed = new Map<string, number>();
	readonly #forMs: number;
	readonly #shared: boolean;

	constructor(
		private now: () => number = Date.now,
		{ forMs = PRICES_FOR_MS, shared = true }: { forMs?: number; shared?: boolean } = {}
	) {
		this.#forMs = forMs;
		this.#shared = shared;
	}

	/** The region's prices, fetched when they're missing or stale; null when they can't be had. */
	async get(region: string, account: string, fetchPrices: () => Promise<T>): Promise<T | null> {
		const now = this.now();
		const key = `${region}\n${account}`;
		const okKey = this.#shared ? region : key;
		const ok = this.#ok.get(okKey);
		if (ok && now - ok.at < this.#forMs) return ok.prices;
		const failed = this.#failed.get(key);
		if (failed !== undefined && now - failed < FAILURE_FOR_MS) return ok?.prices ?? null;
		try {
			const prices = await fetchPrices();
			this.#ok.set(okKey, { at: this.now(), prices });
			this.#failed.delete(key);
			return prices;
		} catch {
			this.#failed.set(key, this.now());
			// stale prices beat none
			return ok?.prices ?? null;
		}
	}

	/** What's kept for the region, however old, without asking AWS. */
	peek(region: string, account: string): T | null {
		return this.#ok.get(this.#shared ? region : `${region}\n${account}`)?.prices ?? null;
	}
}
