import type { GcpClient } from './client';

/**
 * Compute Engine list prices, from the public Cloud Billing catalog.
 *
 * GCE bills a predefined machine as its vCPUs times the family's per-core
 * hourly rate plus its memory (GiB) times the family's per-GiB hourly rate,
 * so the catalog's machine SKUs are one core SKU and one RAM SKU per family,
 * usage type and group of regions, e.g. "N2 Instance Core running in
 * Americas" (usage unit `h`) and "N2 Instance Ram running in Americas"
 * (`GiBy.h`). Spot rates are "Spot Preemptible N2 Instance Core …" with the
 * `Preemptible` usage type.
 *
 * The catalog covers every region and is tens of thousands of SKUs, so it's
 * read a page at a time, keeping only those SKUs, into one small rate table.
 */

/** Compute Engine's service ID in the catalog. */
export const COMPUTE_SERVICE = '6F81-5844-456A';
export const PAGE_SIZE = 5000;
/** A runaway or looping `nextPageToken` stops here; the real catalog is under 20 pages. */
const MAX_PAGES = 100;

/**
 * Premium Tier internet egress, first tier (0–1 TiB a month), in USD per GB,
 * from https://cloud.google.com/vpc/network-pricing#internet_egress. It's
 * $0.085 to $0.12 depending on source and destination (more to China and
 * Australia); $0.12, the worldwide figure, is the conservative standard one.
 * Egress isn't in the Compute Engine catalog, so it's a constant.
 */
export const PREMIUM_EGRESS_PER_GB = 0.12;

export type Usage = 'OnDemand' | 'Preemptible';
type Resource = 'core' | 'ram';

/** Hourly USD rates, by `region|FAMILY|usage|resource`. NaN marks two SKUs that disagree. */
export type RateTable = Map<string, number>;

const rateKey = (region: string, family: string, usage: Usage, resource: Resource) =>
	`${region}|${family}|${usage}|${resource}`;

/**
 * The plain per-family machine SKUs, and nothing else: anything with another
 * word in it (Custom, Extended, Sole Tenancy, Confidential, Commitment, …)
 * fails the pattern. The vendor word in "N2D AMD" or "C3 Intel" is dropped.
 */
const MACHINE_SKU =
	/^(?<spot>(?:Spot )?Preemptible )?(?<family>[A-Z][A-Z0-9]*)(?: (?:AMD|Intel))? Instance (?<resource>Core|Ram) running in \S.*$/;
/** Belt and braces: these SKUs never price a predefined machine. */
const EXCLUDED = /commit|sole tenan|custom|extended|confidential|premium|license/i;
const UNITS: Record<Resource, string> = { core: 'h', ram: 'GiBy.h' };

interface Money {
	currencyCode?: string;
	units?: string | number;
	nanos?: number;
}

export interface Sku {
	description?: string;
	category?: { resourceFamily?: string; usageType?: string };
	serviceRegions?: string[];
	pricingInfo?: {
		pricingExpression?: { usageUnit?: string; tieredRates?: { unitPrice?: Money }[] };
	}[];
}

/** `units` plus `nanos` billionths, as Google's Money type is; null if it isn't one. */
export function money(value: Money | undefined): number | null {
	if (!value || (value.currencyCode !== undefined && value.currencyCode !== 'USD')) return null;
	const units = Number(value.units ?? 0);
	const nanos = value.nanos ?? 0;
	if (typeof nanos !== 'number' || !Number.isFinite(units) || !Number.isFinite(nanos)) return null;
	const amount = units + nanos / 1e9;
	return amount >= 0 ? amount : null;
}

/** Adds a SKU to the table if it's a machine family's core or RAM rate. */
export function addSku(table: RateTable, sku: Sku) {
	const description = sku.description;
	if (typeof description !== 'string' || EXCLUDED.test(description)) return;
	const match = MACHINE_SKU.exec(description);
	if (!match?.groups) return;
	if (sku.category?.resourceFamily !== 'Compute') return;
	const usage = sku.category.usageType;
	if (usage !== (match.groups.spot ? 'Preemptible' : 'OnDemand')) return;
	const resource: Resource = match.groups.resource === 'Core' ? 'core' : 'ram';
	const expression = sku.pricingInfo?.[0]?.pricingExpression;
	if (expression?.usageUnit !== UNITS[resource]) return;
	const rates = expression.tieredRates;
	const rate = Array.isArray(rates) ? money(rates[rates.length - 1]?.unitPrice) : null;
	if (rate === null || !Array.isArray(sku.serviceRegions)) return;
	for (const region of sku.serviceRegions) {
		if (typeof region !== 'string') continue;
		const key = rateKey(region, match.groups.family!, usage, resource);
		const seen = table.get(key);
		// two different prices for the same thing: trust neither
		table.set(key, seen === undefined || seen === rate ? rate : NaN);
	}
}

/** Reads the whole Compute Engine catalog, page by page, into a rate table. */
export async function loadRates(api: GcpClient, deadline: number): Promise<RateTable> {
	const table: RateTable = new Map();
	const seen = new Set<string>();
	let token: string | undefined;
	for (let page = 0; ; page++) {
		if (page >= MAX_PAGES || Date.now() > deadline) throw new Error('The catalog took too long');
		const query = new URLSearchParams({ currencyCode: 'USD', pageSize: String(PAGE_SIZE) });
		if (token) query.set('pageToken', token);
		const body = await api.catalog<{ skus?: unknown; nextPageToken?: unknown }>(
			`services/${COMPUTE_SERVICE}/skus?${query}`
		);
		if (!body || typeof body !== 'object' || !Array.isArray(body.skus)) {
			throw new Error('The catalog sent something that isn’t a SKU list');
		}
		for (const sku of body.skus) if (sku && typeof sku === 'object') addSku(table, sku as Sku);
		token = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
		if (!token) break;
		if (seen.has(token)) throw new Error('The catalog repeated a page');
		seen.add(token);
	}
	if (![...table.values()].some(Number.isFinite))
		throw new Error('The catalog had no machine prices');
	return table;
}

/**
 * Shared-core E2 types bill a fraction of a vCPU at the E2 core rate, with
 * memory at the E2 RAM rate (https://cloud.google.com/compute/vm-instance-pricing#e2_machine_types).
 * Other shared-core types (f1-micro, g1-small) aren't offered, so aren't priced.
 */
const SHARED_CORE: Record<string, number> = { 'e2-micro': 0.25, 'e2-small': 0.5, 'e2-medium': 1 };
/** The machine type families listOffers offers, and their name in the catalog. */
const FAMILIES: Record<string, string> = {
	e2: 'E2',
	n2: 'N2',
	n2d: 'N2D',
	n4: 'N4',
	c3: 'C3',
	c4: 'C4'
};

export interface Machine {
	name: string;
	guestCpus: number;
	memoryMb: number;
}

/** A machine type's hourly price in a region, or null when it can't be priced confidently. */
export function priceOf(table: RateTable, machine: Machine, region: string, usage: Usage) {
	const family = FAMILIES[machine.name.split('-')[0]!];
	if (!family) return null;
	const core = table.get(rateKey(region, family, usage, 'core'));
	const ram = table.get(rateKey(region, family, usage, 'ram'));
	if (core === undefined || ram === undefined || !Number.isFinite(core + ram)) return null;
	const vcpus = SHARED_CORE[machine.name] ?? machine.guestCpus;
	const hourly = vcpus * core + (machine.memoryMb / 1024) * ram;
	// drop floating-point noise, keeping far more precision than any price has
	return Math.round(hourly * 1e9) / 1e9;
}
