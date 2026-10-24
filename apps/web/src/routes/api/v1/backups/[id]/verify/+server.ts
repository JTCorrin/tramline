import { endpoint } from '#lib/server/api/handler.js';
import { backups } from '#lib/server/domain/index.js';

/** Runs a restore drill: proves the backup can be restored, without touching the service. */
export const POST = endpoint((ctx, { params }) => backups.verifyBackup(ctx, params.id!));
