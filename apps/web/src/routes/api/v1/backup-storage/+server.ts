import { SaveBackupStorage } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { backups } from '#lib/server/domain/index.js';
import { isManager } from '#lib/server/domain/access.js';
import { controlPlaneBackups } from '#lib/server/backups/config.server.js';
import { controlPlaneBackupStatus } from '#lib/server/backups/control-plane-jobs.js';

export const GET = endpoint((ctx) => {
	const canManage = isManager(ctx);
	return {
		storage: backups.getStorage(ctx),
		canManage,
		// the install's own backups: status only, for those who manage settings
		controlPlane: canManage
			? controlPlaneBackupStatus(ctx.db, controlPlaneBackups.bucket !== null)
			: null
	};
});

/** Saves the organization's bucket; omit the secret to keep the saved one. */
export const PUT = endpoint(async (ctx, event) =>
	backups.saveStorage(ctx, await body(event, SaveBackupStorage))
);

export const DELETE = endpoint((ctx) => backups.removeStorage(ctx));
