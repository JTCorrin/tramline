import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import * as schema from './schema';

/** Drizzle over better-sqlite3; `$client` is the raw connection (e.g. for `VACUUM INTO`). */
export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** A database handle or an open transaction; helpers that may run inside `db.transaction` take this. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** Migrations live in `apps/web/drizzle`; the app is always started from `apps/web`. */
const MIGRATIONS_DIR = path.resolve('drizzle');

/**
 * Opens (or creates) the SQLite database and applies pending migrations.
 * Pass `:memory:` for tests.
 */
export function createDb(file: string): Db {
	if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

	const sqlite = new Database(file);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('synchronous = NORMAL');
	sqlite.pragma('foreign_keys = ON');
	sqlite.pragma('busy_timeout = 5000');

	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: MIGRATIONS_DIR });
	return db;
}
