import { SaveBackupStorage } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { backups } from '#lib/server/domain/index.js';
import { isManager } from '#lib/server/domain/access.js';

export const GET = endpoint((ctx) => ({
	storage: backups.getStorage(ctx),
	canManage: isManager(ctx)
}));

/** Saves the organization's bucket; omit the secret to keep the saved one. */
export const PUT = endpoint(async (ctx, event) =>
	backups.saveStorage(ctx, await body(event, SaveBackupStorage))
);

export const DELETE = endpoint((ctx) => backups.removeStorage(ctx));
