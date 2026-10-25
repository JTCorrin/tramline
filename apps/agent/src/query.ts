import type { DesiredQuery, QueryResult } from '@tramline/contracts';
import { PassThrough } from 'node:stream';
import type { ContainerRuntime } from './runtime';

/** Results larger than this are refused rather than shipped. */
export const MAX_RESULT_BYTES = 2_000_000;

/**
 * psql inside the database container, with its own credentials. The SQL
 * arrives in the environment, never on a command line, and opens a READ ONLY
 * transaction itself.
 */
export const PSQL =
	'printf \'%s\' "$TRAMLINE_SQL" | psql -X -q -t -A -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "${POSTGRES_DB:-postgres}"';

export async function runQuery(
	runtime: ContainerRuntime,
	query: DesiredQuery
): Promise<QueryResult> {
	const stdout = new PassThrough();
	const chunks: Buffer[] = [];
	let size = 0;
	stdout.on('data', (chunk: Buffer) => {
		size += chunk.length;
		if (size <= MAX_RESULT_BYTES) chunks.push(chunk);
	});
	const errors: string[] = [];
	try {
		const code = await runtime.execStream(query.container, ['sh', '-c', PSQL], {
			env: { TRAMLINE_SQL: query.sql },
			stdout,
			onLine: (stream, line) => {
				if (stream === 'stderr') errors.push(line);
			}
		});
		if (code !== 0)
			return { ok: false, error: errors.slice(-2).join(' ') || `psql exited with ${code}` };
		if (size > MAX_RESULT_BYTES) return { ok: false, error: 'The result is too large to show' };
		return { ok: true, json: Buffer.concat(chunks).toString('utf8').trim() };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
