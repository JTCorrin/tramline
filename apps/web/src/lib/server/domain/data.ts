import type { DataRows, DataTable } from '@tramline/contracts';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { AppError } from '../api/errors';
import { deployment } from '../db/schema';
import { containerName } from '../nodes/names';
import { ask } from '../nodes/queries';
import { requireInstance } from './access';
import type { Ctx } from './context';

/** Rows per page in the data browser. */
export const PAGE_SIZE = 50;
/** Longer text values are cut to this many characters. */
export const MAX_VALUE_LENGTH = 500;

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Every query opens a READ ONLY transaction with a statement timeout, so
 * nothing the data browser runs can change data or hold locks for long.
 */
const readOnly = (select: string) =>
	`BEGIN READ ONLY; SET LOCAL statement_timeout = '5s'; ${select}; COMMIT;`;

/** The live Postgres container of a service, where the data browser's queries run. */
function requirePostgres(ctx: Ctx, serviceId: string, environmentId: string) {
	const { service: svc } = requireInstance(ctx, serviceId, environmentId);
	if (svc.kind !== 'database' || svc.icon !== 'postgres') {
		throw new AppError('conflict', 'The data browser is for Postgres services');
	}
	const live = ctx.db
		.select()
		.from(deployment)
		.where(
			and(
				eq(deployment.serviceId, serviceId),
				eq(deployment.environmentId, environmentId),
				inArray(deployment.status, ['active', 'crashed'])
			)
		)
		.orderBy(desc(deployment.createdAt))
		.get();
	if (!live?.nodeId) throw new AppError('conflict', 'Deploy the database to browse its data');
	return { nodeId: live.nodeId, container: containerName(live.id, 0) };
}

export async function tables(
	ctx: Ctx,
	serviceId: string,
	environmentId: string
): Promise<DataTable[]> {
	const { nodeId, container } = requirePostgres(ctx, serviceId, environmentId);
	const json = await ask(
		nodeId,
		container,
		readOnly(
			`SELECT coalesce(json_agg(t ORDER BY t.schema, t.name), '[]') FROM (
				SELECT n.nspname AS schema, c.relname AS name, c.reltuples::bigint AS estimate
				FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE c.relkind IN ('r', 'p', 'v', 'm')
					AND n.nspname NOT IN ('pg_catalog', 'information_schema')
					AND n.nspname NOT LIKE 'pg_toast%'
			) t`
		)
	);
	return JSON.parse(json) as DataTable[];
}

/** One page of a table's rows. The table must exist: names are never trusted as SQL. */
export async function rows(
	ctx: Ctx,
	query: { serviceId: string; environmentId: string; schema: string; table: string; offset: number }
): Promise<DataRows> {
	const { nodeId, container } = requirePostgres(ctx, query.serviceId, query.environmentId);
	const known = await tables(ctx, query.serviceId, query.environmentId);
	if (!known.some((t) => t.schema === query.schema && t.name === query.table)) {
		throw new AppError('not_found', 'Table not found');
	}
	const offset = Math.max(0, Math.floor(query.offset) || 0);
	const qualified = `${ident(query.schema)}.${ident(query.table)}`;
	const json = await ask(
		nodeId,
		container,
		readOnly(
			`SELECT json_build_object(
				'columns', (SELECT coalesce(json_agg(a.attname ORDER BY a.attnum), '[]') FROM pg_attribute a
					WHERE a.attrelid = (quote_ident(${literal(query.schema)}) || '.' || quote_ident(${literal(query.table)}))::regclass
					AND a.attnum > 0 AND NOT a.attisdropped),
				'rows', (SELECT coalesce(json_agg(r), '[]') FROM (SELECT * FROM ${qualified} LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}) r)
			)`
		)
	);
	const result = JSON.parse(json) as { columns: string[]; rows: Record<string, unknown>[] };
	return {
		columns: result.columns,
		rows: result.rows.slice(0, PAGE_SIZE).map(shorten),
		offset,
		hasMore: result.rows.length > PAGE_SIZE
	};
}

/** Cuts long values short, so one huge cell can't swamp the browser. */
function shorten(row: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(row).map(([key, value]) => {
			const text =
				typeof value === 'string'
					? value
					: value !== null && typeof value === 'object'
						? JSON.stringify(value)
						: null;
			if (text === null || text.length <= MAX_VALUE_LENGTH) return [key, value];
			return [key, `${text.slice(0, MAX_VALUE_LENGTH)}…`];
		})
	);
}
