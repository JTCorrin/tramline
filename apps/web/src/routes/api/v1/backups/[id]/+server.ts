import { endpoint } from '#lib/server/api/handler.js';
import { backups } from '#lib/server/domain/index.js';

/** Deletes the backup and its object in the bucket. */
export const DELETE = endpoint((ctx, { params }) => backups.removeBackup(ctx, params.id!), {
	scope: 'deploy'
});
