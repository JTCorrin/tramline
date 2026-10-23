import {
	DEFAULT_SERVICE_CONFIG,
	mergeConfig,
	type DesiredContainer,
	type DesiredState,
	type IngressRoute
} from '@tramline/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Secrets } from '../crypto';
import type { DbOrTx } from '../db/client';
import { deployment, serviceInstance } from '../db/schema';
import { usesTls, type PlatformSettings } from '../settings';

/** Deployments whose containers should exist. */
export const RUNNING_STATUSES = ['deploying', 'active', 'crashed'] as const;

export const networkName = (environmentId: string) => `tl-${environmentId}`;
export const deploymentAlias = (deploymentId: string) => `${deploymentId}.tramline.internal`;
export const containerName = (deploymentId: string, replica: number) =>
	`tl-${deploymentId}-${replica}`;

/**
 * Everything one node should be running. Deterministic: the same database
 * state always produces the same document and revision.
 */
export function buildDesiredState(
	db: DbOrTx,
	secrets: Secrets,
	settings: PlatformSettings,
	nodeId: string
): DesiredState {
	const rows = db
		.select({ deployment, domain: serviceInstance.domain })
		.from(deployment)
		.innerJoin(
			serviceInstance,
			and(
				eq(serviceInstance.serviceId, deployment.serviceId),
				eq(serviceInstance.environmentId, deployment.environmentId)
			)
		)
		.where(and(eq(deployment.nodeId, nodeId), inArray(deployment.status, [...RUNNING_STATUSES])))
		.orderBy(deployment.id)
		.all();

	const containers: DesiredContainer[] = [];
	const routes: IngressRoute[] = [];
	const networks = new Set<string>();

	for (const { deployment: dep, domain } of rows) {
		// snapshots taken before a field existed pick up its default
		const config = mergeConfig(DEFAULT_SERVICE_CONFIG, dep.config);
		if (config.source?.type !== 'image') continue; // repo sources need a build first (Phase 3)

		const env = JSON.parse(secrets.decrypt(dep.variables)) as Record<string, string>;
		const network = networkName(dep.environmentId);
		networks.add(network);
		const aliases = [env.TRAMLINE_PRIVATE_DOMAIN, deploymentAlias(dep.id)].filter(
			(alias): alias is string => Boolean(alias)
		);

		for (let replica = 0; replica < config.deploy.replicas; replica++) {
			containers.push({
				name: containerName(dep.id, replica),
				deploymentId: dep.id,
				serviceId: dep.serviceId,
				environmentId: dep.environmentId,
				replica,
				image: config.source.image,
				command: config.deploy.startCommand,
				env,
				network,
				aliases,
				restartPolicy: config.deploy.restartPolicy,
				port: config.networking.port,
				healthcheckPath: config.deploy.healthcheckPath,
				memoryMb: config.deploy.memoryMb,
				readOnlyRootFilesystem: config.deploy.readOnlyRootFilesystem
			});
		}

		// public traffic only ever goes to the live deployment, which is what makes swaps zero-downtime
		const live = dep.status === 'active' || dep.status === 'crashed';
		if (live && domain && config.networking.publicDomain && config.networking.port) {
			routes.push({
				host: domain,
				upstreams: [`${deploymentAlias(dep.id)}:${config.networking.port}`],
				network
			});
		}
	}

	const document = {
		networks: [...networks].sort(),
		containers,
		ingress: { httpPort: settings.ingressPort, tls: usesTls(settings), routes }
	};
	const revision = createHash('sha256').update(JSON.stringify(document)).digest('hex').slice(0, 16);
	return { revision, ...document };
}
