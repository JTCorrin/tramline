import type { AdapterOffer, Placement, PlacementRequest } from '@tramline/contracts';
import { PlacementRequest as PlacementSchema } from '@tramline/contracts';
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Secrets } from '../crypto';
import type { DbOrTx } from '../db/client';
import { adapterAccount, node, nodePool, priceOffer, priceRegion } from '../db/schema';
import { connect, call, requireAccount } from '../domain/adapters';
import type { Ctx } from '../domain/context';
import { list as listNodes } from '../domain/nodes';
import { HOURS_PER_MONTH } from './costs';
import { requireInstallAdmin } from '../domain/admins';
import { gpuMatches, offerFits } from '../nodes/gpus';

/** Prices are refreshed this often. */
export const PRICE_TTL_MS = 24 * 3600_000;
/** A refresh that failed is tried again after this. */
export const RETRY_MS = 3600_000;
/** A region nobody uses stops refreshing this long after it was last compared. */
export const WANTED_MS = 30 * 24 * 3600_000;
/** Regions refreshed per run of the job, so a big install doesn't call every provider at once. */
const PER_RUN = 4;

type AccountRow = typeof adapterAccount.$inferSelect;

/** Asks the account's adapter for a region's sizes and replaces what was kept. Throws on failure. */
export async function refreshRegion(
	db: DbOrTx,
	secrets: Secrets,
	account: AccountRow,
	region: string,
	now = new Date()
) {
	const keep = (error: string | null) =>
		db
			.insert(priceRegion)
			.values({ accountId: account.id, region, wantedAt: now, triedAt: now, error })
			.onConflictDoUpdate({
				target: [priceRegion.accountId, priceRegion.region],
				set: { triedAt: now, error, ...(error ? {} : { fetchedAt: now }) }
			})
			.run();
	let offers: AdapterOffer[];
	try {
		const { adapter, creds } = connect({ secrets }, account);
		offers = await call(account, () => adapter.listOffers(creds, region));
	} catch (error) {
		keep(error instanceof Error ? error.message : String(error));
		throw error;
	}
	db.transaction((tx) => {
		tx.delete(priceOffer)
			.where(and(eq(priceOffer.accountId, account.id), eq(priceOffer.region, region)))
			.run();
		for (const o of offers) {
			tx.insert(priceOffer)
				.values({
					accountId: account.id,
					region,
					offerId: o.id,
					name: o.name,
					vcpus: o.vcpus,
					memoryMb: o.memoryMb,
					diskGb: o.diskGb,
					arch: o.arch,
					gpu: o.gpu,
					hourly: o.hourly,
					spotHourly: o.spotHourly,
					egressPerGb: o.egressPerGb,
					fetchedAt: now
				})
				.onConflictDoNothing()
				.run();
		}
		tx.insert(priceRegion)
			.values({ accountId: account.id, region, wantedAt: now, triedAt: now, fetchedAt: now })
			.onConflictDoUpdate({
				target: [priceRegion.accountId, priceRegion.region],
				set: { triedAt: now, fetchedAt: now, error: null }
			})
			.run();
	});
	return offers.length;
}

/**
 * Regions node pools grow in, and regions machines were created in: kept
 * fresh whether or not anyone compares them, to price what runs there.
 */
function regionsInUse(db: DbOrTx) {
	const seen = new Map<string, { accountId: string; region: string }>();
	const used = [
		...db
			.select({ accountId: nodePool.adapterAccountId, region: nodePool.region })
			.from(nodePool)
			.all(),
		...db
			.select({ accountId: node.adapterAccountId, region: node.region })
			.from(node)
			.where(and(isNotNull(node.adapterAccountId), isNotNull(node.region)))
			.all()
	];
	for (const u of used) {
		if (u.accountId && u.region)
			seen.set(`${u.accountId}\n${u.region}`, { accountId: u.accountId, region: u.region });
	}
	return [...seen.values()];
}

/**
 * The daily refresh: regions in use, or compared in the last 30 days, whose
 * prices are a day old (or whose last try failed an hour ago), oldest first,
 * a few at a time. Failures are kept on the region for the comparison to show.
 */
export async function syncPrices(db: DbOrTx, secrets: Secrets, now = new Date()) {
	for (const { accountId, region } of regionsInUse(db)) {
		db.insert(priceRegion)
			.values({ accountId, region, wantedAt: now })
			.onConflictDoUpdate({
				target: [priceRegion.accountId, priceRegion.region],
				set: { wantedAt: now }
			})
			.run();
	}
	const t = now.getTime();
	db.delete(priceRegion)
		.where(lt(priceRegion.wantedAt, new Date(t - WANTED_MS)))
		.run();
	// with the regions they belong to
	db.delete(priceOffer)
		.where(
			sql`not exists (select 1 from ${priceRegion} where ${priceRegion.accountId} = ${priceOffer.accountId} and ${priceRegion.region} = ${priceOffer.region})`
		)
		.run();
	const due = db
		.select()
		.from(priceRegion)
		.where(
			or(
				isNull(priceRegion.triedAt),
				and(isNull(priceRegion.error), lt(priceRegion.triedAt, new Date(t - PRICE_TTL_MS))),
				and(isNotNull(priceRegion.error), lt(priceRegion.triedAt, new Date(t - RETRY_MS)))
			)
		)
		.orderBy(priceRegion.triedAt)
		.limit(PER_RUN)
		.all();
	let refreshed = 0;
	for (const r of due) {
		const account = db
			.select()
			.from(adapterAccount)
			.where(eq(adapterAccount.id, r.accountId))
			.get();
		if (!account) continue;
		await refreshRegion(db, secrets, account, r.region, now).then(
			() => refreshed++,
			() => {}
		);
	}
	return refreshed;
}

/**
 * Where a workload could run, cheapest first. Nodes with room for it come
 * first, since they cost nothing more. Then every kept size that fits, from
 * every account and region priced so far, ranked by its monthly price (spot
 * when asked for and offered); sizes without a price come last. Regions in
 * `regions` are priced now if they haven't been, and kept from then on.
 */
export async function placement(
	ctx: Ctx,
	input: PlacementRequest,
	now = new Date()
): Promise<Placement> {
	requireInstallAdmin(ctx, 'compare prices');
	const req = PlacementSchema.parse(input);

	for (const { account, region } of req.regions) {
		const row = requireAccount(ctx, account);
		const kept = ctx.db
			.select()
			.from(priceRegion)
			.where(and(eq(priceRegion.accountId, row.id), eq(priceRegion.region, region)))
			.get();
		if (kept?.fetchedAt && now.getTime() - kept.fetchedAt.getTime() < PRICE_TTL_MS) {
			ctx.db
				.update(priceRegion)
				.set({ wantedAt: now })
				.where(and(eq(priceRegion.accountId, row.id), eq(priceRegion.region, region)))
				.run();
			continue;
		}
		// a region that fails shows its error; the others still compare
		await refreshRegion(ctx.db, ctx.secrets, row, region, now).catch(() => {});
	}

	// an agent reports Node's names for architectures (x64, arm64)
	const arches = new Map(
		ctx.db
			.select({ id: node.id, info: node.info })
			.from(node)
			.all()
			.map((n) => [n.id, n.info?.arch === 'x64' ? 'amd64' : n.info?.arch])
	);
	const existing = listNodes(ctx)
		.filter((n) => n.status === 'online' && !n.cordoned && !n.draining && n.cpus && n.memoryMb)
		.filter((n) => !req.arch || arches.get(n.id) === req.arch)
		.map((n) => {
			const matching = req.gpus
				? n.gpus.filter((g) =>
						gpuMatches(
							{ model: g.model, vramGb: g.vramMb ? Math.floor(g.vramMb / 1024) : null },
							req.gpus!
						)
					).length
				: 0;
			return {
				nodeId: n.id,
				name: n.name,
				freeCpus: Math.round((n.cpus! - n.allocatedCpus) * 100) / 100,
				freeMemoryMb: n.memoryMb! - n.allocatedMemoryMb,
				freeGpus: Math.max(0, Math.min(matching, n.gpus.length - n.allocatedGpus))
			};
		})
		.filter(
			(n) =>
				n.freeCpus >= req.vcpus &&
				n.freeMemoryMb >= req.memoryMb &&
				(!req.gpus || n.freeGpus >= req.gpus.count)
		)
		.sort((a, b) => a.freeMemoryMb - b.freeMemoryMb);

	const accounts = new Map(
		ctx.db
			.select()
			.from(adapterAccount)
			.all()
			.map((a) => [a.id, a])
	);
	const offers = ctx.db
		.select()
		.from(priceOffer)
		.all()
		.filter(
			(o) =>
				accounts.has(o.accountId) &&
				o.vcpus >= req.vcpus &&
				o.memoryMb >= req.memoryMb &&
				(!req.arch || o.arch === req.arch) &&
				offerFits(o.gpu, req.gpus)
		)
		.map((o) => {
			const account = accounts.get(o.accountId)!;
			const spot = req.spot && o.spotHourly !== null;
			const hourly = spot ? o.spotHourly : o.hourly;
			const egress =
				req.egressGb === 0 ? 0 : o.egressPerGb === null ? null : req.egressGb * o.egressPerGb;
			return {
				account: { id: account.id, name: account.name, adapter: account.adapter },
				offer: {
					id: o.offerId,
					region: o.region,
					name: o.name,
					vcpus: o.vcpus,
					memoryMb: o.memoryMb,
					diskGb: o.diskGb,
					arch: o.arch,
					gpu: o.gpu,
					hourly: o.hourly,
					spotHourly: o.spotHourly,
					egressPerGb: o.egressPerGb
				},
				hourly,
				monthly:
					hourly === null
						? null
						: Math.round((hourly * HOURS_PER_MONTH + (egress ?? 0)) * 100) / 100,
				egress: egress === null ? null : Math.round(egress * 100) / 100,
				spot,
				fetchedAt: o.fetchedAt.toISOString()
			};
		})
		.sort(
			(a, b) =>
				(a.monthly ?? Infinity) - (b.monthly ?? Infinity) ||
				a.offer.vcpus - b.offer.vcpus ||
				a.offer.memoryMb - b.offer.memoryMb ||
				a.account.name.localeCompare(b.account.name) ||
				a.offer.region.localeCompare(b.offer.region)
		);

	const regions = ctx.db
		.select()
		.from(priceRegion)
		.all()
		.filter((r) => accounts.has(r.accountId))
		.map((r) => ({
			account: { id: r.accountId, name: accounts.get(r.accountId)!.name },
			region: r.region,
			fetchedAt: r.fetchedAt?.toISOString() ?? null,
			error: r.error
		}))
		.sort(
			(a, b) => a.account.name.localeCompare(b.account.name) || a.region.localeCompare(b.region)
		);

	return { existing, offers, regions };
}
