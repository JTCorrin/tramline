import { z } from 'zod';
import { ScanResult } from './scan';

export const DEPLOYMENT_STATUSES = [
	'queued',
	'building',
	'deploying',
	'active',
	'failed',
	'crashed',
	'removed'
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const Deployment = z.object({
	id: z.string(),
	serviceId: z.string(),
	environmentId: z.string(),
	status: z.enum(DEPLOYMENT_STATUSES),
	/** Image or repo@branch, for display. */
	source: z.string().nullable(),
	/** Why it is in its current status, e.g. "Waiting for a node" or an image pull error. */
	message: z.string().nullable(),
	/** The commit built, for source deployments. */
	commit: z.string().nullable(),
	/** For cron services: when the next run starts. */
	nextRunAt: z.iso.datetime().nullable(),
	/** Vulnerability scan of the image, when one ran. */
	scan: ScanResult.nullable(),
	createdBy: z.string().nullable(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime()
});

export type Deployment = z.infer<typeof Deployment>;

export type DeploymentQuery = { serviceId: string; environmentId: string };

/** One run of a cron service. */
export const CronRun = z.object({
	id: z.string(),
	deploymentId: z.string(),
	trigger: z.enum(['schedule', 'manual']),
	/** `skipped` when the previous run was still going. */
	status: z.enum(['running', 'succeeded', 'failed', 'skipped']),
	exitCode: z.number().int().nullable(),
	scheduledFor: z.iso.datetime(),
	finishedAt: z.iso.datetime().nullable()
});

export type CronRun = z.infer<typeof CronRun>;
