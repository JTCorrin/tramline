import { endpoint } from '#lib/server/api/handler.js';
import { backups } from '#lib/server/domain/index.js';

/** Writes and deletes a test object with the saved settings. */
export const POST = endpoint((ctx) => backups.testStorage(ctx));
