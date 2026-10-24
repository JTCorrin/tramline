import * as env from '$app/env/private';
import { controlPlaneBucket, snapshotKey } from './control-plane';
import type { ControlPlaneBackupConfig } from './control-plane-jobs';

/** Control-plane backups as configured by `TRAMLINE_BACKUP_*`. */
export const controlPlaneBackups: ControlPlaneBackupConfig = {
	bucket: controlPlaneBucket({
		TRAMLINE_BACKUP_S3_ENDPOINT: env.TRAMLINE_BACKUP_S3_ENDPOINT,
		TRAMLINE_BACKUP_S3_REGION: env.TRAMLINE_BACKUP_S3_REGION,
		TRAMLINE_BACKUP_S3_BUCKET: env.TRAMLINE_BACKUP_S3_BUCKET,
		TRAMLINE_BACKUP_S3_PREFIX: env.TRAMLINE_BACKUP_S3_PREFIX,
		TRAMLINE_BACKUP_S3_ACCESS_KEY_ID: env.TRAMLINE_BACKUP_S3_ACCESS_KEY_ID,
		TRAMLINE_BACKUP_S3_SECRET_ACCESS_KEY: env.TRAMLINE_BACKUP_S3_SECRET_ACCESS_KEY,
		TRAMLINE_BACKUP_S3_PATH_STYLE: env.TRAMLINE_BACKUP_S3_PATH_STYLE
	}),
	key: snapshotKey(env.TRAMLINE_SECRET_KEY),
	intervalMinutes: env.TRAMLINE_BACKUP_INTERVAL_MINUTES,
	keep: env.TRAMLINE_BACKUP_KEEP
};
