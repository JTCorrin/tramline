import type { DesiredQuery, QueryResult } from '@tramline/contracts';
import { randomBytes } from 'node:crypto';
import { AppError } from '../api/errors';
import { notifyNodes } from './bus';

/** How long a data browser request waits for its node to answer. */
export const QUERY_TIMEOUT_MS = 15_000;

interface Pending extends DesiredQuery {
	nodeId: string;
	resolve: (json: string) => void;
	reject: (error: Error) => void;
}

/**
 * Data browser queries waiting for their node. They live only in memory:
 * they ride along in the node's desired state until the agent posts the
 * answer, and are never stored.
 */
const pending = new Map<string, Pending>();

/** Asks a node to run read-only SQL in a container, resolving with its JSON output. */
export function ask(nodeId: string, container: string, sql: string, timeoutMs = QUERY_TIMEOUT_MS) {
	const id = `qry_${randomBytes(12).toString('hex')}`;
	return new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new AppError('conflict', 'The node did not answer in time'));
		}, timeoutMs);
		pending.set(id, {
			id,
			nodeId,
			container,
			sql,
			resolve: (json) => {
				clearTimeout(timer);
				resolve(json);
			},
			reject: (error) => {
				clearTimeout(timer);
				reject(error);
			}
		});
		notifyNodes();
	});
}

/** The queries a node should run now, for its desired state. */
export function pendingQueries(nodeId: string): DesiredQuery[] {
	return [...pending.values()]
		.filter((q) => q.nodeId === nodeId)
		.map(({ id, container, sql }) => ({ id, container, sql }));
}

/** Delivers a node's answer; answers for other nodes' queries are ignored. */
export function answer(nodeId: string, id: string, result: QueryResult) {
	const query = pending.get(id);
	if (!query || query.nodeId !== nodeId) return false;
	pending.delete(id);
	notifyNodes();
	if (result.ok) query.resolve(result.json);
	else query.reject(new AppError('conflict', result.error));
	return true;
}
