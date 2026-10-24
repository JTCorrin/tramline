/** Names shared by the desired state, the reconciler and backups. */

/** Deployments whose containers should exist. */
export const RUNNING_STATUSES = ['deploying', 'active', 'crashed'] as const;

/** Local tag for an image built from source. */
export const builtImageTag = (serviceId: string, deploymentId: string) =>
	`tramline/${serviceId}:${deploymentId}`;

export const networkName = (environmentId: string) => `tl-${environmentId}`;
export const deploymentAlias = (deploymentId: string) => `${deploymentId}.tramline.internal`;
export const containerName = (deploymentId: string, replica: number) =>
	`tl-${deploymentId}-${replica}`;
