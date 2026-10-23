import { z } from 'zod';

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
	createdBy: z.string().nullable(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime()
});

export type Deployment = z.infer<typeof Deployment>;

export type DeploymentQuery = { serviceId: string; environmentId: string };
