import type { Db } from '../db/client';

/**
 * Everything a domain function needs to act on behalf of a caller.
 * Built per request by the API layer; built directly in tests.
 */
export interface Ctx {
	db: Db;
	userId: string;
	organizationId: string;
}
