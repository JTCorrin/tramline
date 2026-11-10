import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { adapterAccount, type OfferGpu } from './nodes';
import { environment, service } from './services';

/**
 * Machine sizes and their prices, as each compute account's adapter last
 * listed them for a region. Refreshed daily for the regions in use, so a
 * comparison across providers doesn't wait on every provider's API.
 */
export const priceOffer = sqliteTable(
	'price_offer',
	{
		accountId: text('account_id')
			.notNull()
			.references(() => adapterAccount.id, { onDelete: 'cascade' }),
		region: text('region').notNull(),
		offerId: text('offer_id').notNull(),
		name: text('name').notNull(),
		vcpus: integer('vcpus').notNull(),
		memoryMb: integer('memory_mb').notNull(),
		diskGb: integer('disk_gb'),
		arch: text('arch', { enum: ['amd64', 'arm64'] }).notNull(),
		gpu: text('gpu', { mode: 'json' }).$type<OfferGpu>(),
		/** US dollars an hour; null when the provider doesn't say. */
		hourly: real('hourly'),
		spotHourly: real('spot_hourly'),
		egressPerGb: real('egress_per_gb'),
		fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [primaryKey({ columns: [t.accountId, t.region, t.offerId] })]
);

/**
 * A region whose prices are kept: one a node or pool uses, or one someone
 * compared lately. `fetchedAt` and `error` say how the last refresh went.
 */
export const priceRegion = sqliteTable(
	'price_region',
	{
		accountId: text('account_id')
			.notNull()
			.references(() => adapterAccount.id, { onDelete: 'cascade' }),
		region: text('region').notNull(),
		/** Last asked for in a comparison; regions nobody uses or asks about stop refreshing. */
		wantedAt: integer('wanted_at', { mode: 'timestamp_ms' }).notNull(),
		fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }),
		/** Why the last refresh failed; cleared by one that works. */
		error: text('error'),
		/** When the last refresh was tried, successful or not. */
		triedAt: integer('tried_at', { mode: 'timestamp_ms' })
	},
	(t) => [
		primaryKey({ columns: [t.accountId, t.region] }),
		index('price_region_tried').on(t.triedAt)
	]
);

/**
 * What each node cost on a day (UTC), in US dollars, added up every few
 * minutes from its monthly cost while Tramline runs. Kept by name with no
 * link to the node, so a removed machine's spend stays in the history.
 */
export const nodeSpend = sqliteTable(
	'node_spend',
	{
		day: text('day').notNull(),
		nodeId: text('node_id').notNull(),
		nodeName: text('node_name').notNull(),
		amount: real('amount').notNull()
	},
	(t) => [primaryKey({ columns: [t.day, t.nodeId] })]
);

/** Each service's share of that, per environment and day; it goes with the service. */
export const serviceSpend = sqliteTable(
	'service_spend',
	{
		day: text('day').notNull(),
		serviceId: text('service_id')
			.notNull()
			.references(() => service.id, { onDelete: 'cascade' }),
		environmentId: text('environment_id')
			.notNull()
			.references(() => environment.id, { onDelete: 'cascade' }),
		amount: real('amount').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.day, t.serviceId, t.environmentId] }),
		index('service_spend_environment').on(t.environmentId, t.day)
	]
);
