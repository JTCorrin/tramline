import { z } from 'zod';

/**
 * Where an organization's backups go: any S3-compatible bucket. The secret
 * key is write-only; it is never returned.
 */
export const BackupStorage = z.object({
	endpoint: z.string(),
	region: z.string(),
	bucket: z.string(),
	/** Folder inside the bucket; may be empty. */
	prefix: z.string(),
	accessKeyId: z.string(),
	pathStyle: z.boolean()
});

export type BackupStorage = z.infer<typeof BackupStorage>;

export const SaveBackupStorage = z.object({
	endpoint: z
		.url({ protocol: /^https?$/, message: 'Use the bucket service’s http(s) URL' })
		.trim()
		.transform((value) => value.replace(/\/+$/, '')),
	region: z.string().trim().min(1).default('us-east-1'),
	bucket: z
		.string()
		.trim()
		.regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Not a valid bucket name'),
	prefix: z
		.string()
		.trim()
		.transform((value) => value.replace(/^\/+|\/+$/g, ''))
		.default(''),
	accessKeyId: z.string().trim().min(1, 'Access key ID is required'),
	/** Omit to keep the saved one. */
	secretAccessKey: z.string().trim().min(1).optional(),
	pathStyle: z.boolean().default(true)
});

export type SaveBackupStorage = z.input<typeof SaveBackupStorage>;

export const BACKUP_SCHEDULES = ['off', 'daily', 'weekly'] as const;

/** A service's volume in one environment, and how it is backed up. */
export const Volume = z.object({
	id: z.string(),
	serviceId: z.string(),
	environmentId: z.string(),
	/** What a backup contains: a native database dump, or an archive of the volume. */
	backupKind: z.enum(['postgres', 'mysql', 'mongo', 'volume']),
	backupSchedule: z.enum(BACKUP_SCHEDULES),
	/** Scheduled backups kept; older ones are deleted from the bucket. */
	backupRetention: z.number().int(),
	createdAt: z.iso.datetime()
});

export type Volume = z.infer<typeof Volume>;

export type VolumeQuery = { serviceId: string; environmentId: string };

export const UpdateVolume = z
	.object({
		backupSchedule: z.enum(BACKUP_SCHEDULES),
		backupRetention: z.number().int().min(1).max(90)
	})
	.partial();

export type UpdateVolume = z.infer<typeof UpdateVolume>;

export const BACKUP_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;

export const Backup = z.object({
	id: z.string(),
	volumeId: z.string(),
	kind: Volume.shape.backupKind,
	trigger: z.enum(['manual', 'scheduled']),
	status: z.enum(BACKUP_STATUSES),
	/** Encrypted size in bytes. */
	size: z.number().int().nullable(),
	error: z.string().nullable(),
	/** The latest restore drill: proof the backup can be restored. */
	drill: z
		.object({
			status: z.enum(BACKUP_STATUSES),
			detail: z.string().nullable(),
			error: z.string().nullable(),
			createdAt: z.iso.datetime()
		})
		.nullable(),
	/** When the latest restore from this backup ran, and how it went. */
	restore: z
		.object({
			status: z.enum(BACKUP_STATUSES),
			error: z.string().nullable(),
			createdAt: z.iso.datetime()
		})
		.nullable(),
	createdAt: z.iso.datetime(),
	finishedAt: z.iso.datetime().nullable()
});

export type Backup = z.infer<typeof Backup>;

export type BackupQuery = { volumeId: string };

const ControlPlaneJob = z
	.object({
		status: z.enum(['succeeded', 'failed']),
		size: z.number().int().nullable(),
		detail: z.record(z.string(), z.unknown()).nullable(),
		error: z.string().nullable(),
		createdAt: z.iso.datetime()
	})
	.nullable();

/** Backups of this install's own database (configured with TRAMLINE_BACKUP_S3_*). */
export const ControlPlaneBackupStatus = z.object({
	configured: z.boolean(),
	snapshot: ControlPlaneJob,
	drill: ControlPlaneJob
});

export type ControlPlaneBackupStatus = z.infer<typeof ControlPlaneBackupStatus>;
