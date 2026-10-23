import type { Secrets } from '../crypto';
import type { Db } from '../db/client';
import type { PlatformSettings } from '../settings';

/**
 * Everything a domain function needs to act on behalf of a caller.
 * Built per request by the API layer; built directly in tests.
 */
export interface Ctx {
	db: Db;
	secrets: Secrets;
	settings: PlatformSettings;
	userId: string;
	organizationId: string;
}
