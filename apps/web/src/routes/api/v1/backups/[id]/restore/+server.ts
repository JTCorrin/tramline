import { endpoint } from '#lib/server/api/handler.js';
import { backups } from '#lib/server/domain/index.js';

/** Restores the backup into its volume, replacing what is there. */
export const POST = endpoint((ctx, { params }) => backups.restoreBackup(ctx, params.id!));
