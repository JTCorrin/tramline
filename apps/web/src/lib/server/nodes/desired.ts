import {
	DEFAULT_SERVICE_CONFIG,
	mergeConfig,
	type DesiredBuild,
	type DesiredScan,
	type DesiredContainer,
	type DesiredState,
	type IngressRoute
} from '@tramline/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Secrets } from '../crypto';
import type { DbOrTx } from '../db/client';
import { container, deployment, node, serviceInstance } from '../db/schema';
import { usesTls, type PlatformSettings } from '../settings';
import { runContainerName, runningRuns } from './cron';
import { meshAlias, meshExports, meshMembers, meshNetworkName, meshPorts, planMesh } from './mesh';
import { pendingQueries } from './queries';
import { deletedVolumes, recreatePlan, volumeFor, volumeName } from './volumes';

export {
	builtImageTag,
	containerName,
	deploymentAlias,
	networkName,
	RUNNING_STATUSES
} from './names';
import {
	builtImageTag,
	containerName,
	deploymentAlias,
	networkName,
	RUNNING_STATUSES
} from './names';
import { backupJobs } from '../domain/backups';
import { verifiedHostnames } from '../domain/domains';

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
		.where(
			and(
				eq(deployment.nodeId, nodeId),
				inArray(deployment.status, [...RUNNING_STATUSES, 'building'])
			)
		)
		.orderBy(deployment.id)
		.all();

	const reported = new Set(
		db
			.select({ deploymentId: container.deploymentId })
			.from(container)
			.where(eq(container.nodeId, nodeId))
			.all()
			.map((row) => row.deploymentId)
	);
	const recreate = recreatePlan(
		rows.map((row) => row.deployment),
		reported
	);

	const hostnames = verifiedHostnames(db);
	const runs = Map.groupBy(
		runningRuns(
			db,
			rows.map((row) => row.deployment.id)
		),
		(run) => run.deploymentId
	);
	const containers: DesiredContainer[] = [];
	const builds: DesiredBuild[] = [];
	const scans: DesiredScan[] = [];
	const routes: IngressRoute[] = [];
	const networks = new Set<string>();

	for (const { deployment: dep, domain } of rows) {
		// snapshots taken before a field existed pick up its default
		const config = mergeConfig(DEFAULT_SERVICE_CONFIG, dep.config);
		const env = JSON.parse(secrets.decrypt(dep.variables)) as Record<string, string>;

		if (dep.status === 'building') {
			if (config.source?.type === 'image') {
				if (config.build.scan !== 'off') {
					scans.push({ deploymentId: dep.id, image: config.source.image, scan: config.build.scan });
				}
				continue;
			}
			if (config.source?.type !== 'repo') continue;
			builds.push({
				deploymentId: dep.id,
				serviceId: dep.serviceId,
				repo: config.source.repo,
				ref: config.source.branch,
				commit: dep.commit,
				token: null,
				rootDirectory: config.source.rootDirectory,
				builder: config.build.builder,
				dockerfilePath: config.build.dockerfilePath,
				buildCommand: config.build.buildCommand,
				startCommand: config.deploy.startCommand,
				image: builtImageTag(dep.serviceId, dep.id),
				// every variable is available to the build, as on Railway, but only as a BuildKit secret
				secrets: env,
				scan: config.build.scan
			});
			continue;
		}

		// a built image, or the configured one
		const image = dep.image ?? (config.source?.type === 'image' ? config.source.image : null);
		if (!image) continue;
		// volume services: the old deployment stops before the new one starts
		if (recreate.stopped.has(dep.id) || recreate.waiting.has(dep.id)) continue;
		const mountPath = config.volume.mountPath;
		const vol = mountPath ? volumeFor(db, dep.serviceId, dep.environmentId) : undefined;
		const volumes = vol && mountPath ? [{ name: volumeName(vol.id), target: mountPath }] : [];
		const network = networkName(dep.environmentId);
		networks.add(network);
		const aliases = [env.TRAMLINE_PRIVATE_DOMAIN, deploymentAlias(dep.id)].filter(
			(alias): alias is string => Boolean(alias)
		);

		// a cron service only has containers while a run is going
		if (config.deploy.cronSchedule) {
			for (const run of runs.get(dep.id) ?? []) {
				containers.push({
					name: runContainerName(run.id),
					deploymentId: dep.id,
					serviceId: dep.serviceId,
					environmentId: dep.environmentId,
					replica: 0,
					image,
					command: config.deploy.startCommand,
					env,
					network,
					aliases: [],
					restartPolicy: 'never',
					port: null,
					healthcheckPath: null,
					memoryMb: config.deploy.memoryMb,
					readOnlyRootFilesystem: config.deploy.readOnlyRootFilesystem,
					volumes
				});
			}
			continue;
		}

		for (let replica = 0; replica < config.deploy.replicas; replica++) {
			containers.push({
				name: containerName(dep.id, replica),
				deploymentId: dep.id,
				serviceId: dep.serviceId,
				environmentId: dep.environmentId,
				replica,
				image,
				command: config.deploy.startCommand,
				env,
				network,
				aliases,
				restartPolicy: config.deploy.restartPolicy,
				port: config.networking.port,
				healthcheckPath: config.deploy.healthcheckPath,
				memoryMb: config.deploy.memoryMb,
				readOnlyRootFilesystem: config.deploy.readOnlyRootFilesystem,
				volumes
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
		// the user's own domains, once their ownership is proven
		if (live && config.networking.port) {
			for (const custom of hostnames.get(`${dep.serviceId}:${dep.environmentId}`) ?? []) {
				routes.push({
					host: custom.hostname,
					upstreams: [`${deploymentAlias(dep.id)}:${config.networking.port}`],
					network,
					custom: true
				});
			}
		}
	}

	// other nodes' services, over the mesh
	const self = db.select().from(node).where(eq(node.id, nodeId)).get();
	const members = meshMembers(db);
	const exports = members.length >= 2 ? meshExports(db, secrets) : [];
	const mesh = planMesh(members, exports, {
		id: nodeId,
		edge: self?.edge ?? false,
		networks: [...networks]
	});
	if (mesh) {
		// links, the ingress and the mesh container meet on this network
		networks.add(meshNetworkName(nodeId));
		const ports = meshPorts(exports);
		const forwarded = new Set(mesh.forwards.filter((f) => f.to === 'remote').map((f) => f.port));
		for (const e of exports) {
			const port = ports.get(`${e.environmentId}:${e.serviceId}`)!;
			if (!self?.edge || e.nodeId === nodeId || !forwarded.has(port)) continue;
			for (const { host, custom } of e.hosts) {
				routes.push({
					host,
					upstreams: [`${meshAlias(nodeId)}:${port}`],
					network: meshNetworkName(nodeId),
					...(custom ? { custom: true } : {})
				});
			}
		}
	}

	const document = {
		networks: [...networks].sort(),
		containers,
		builds,
		scans,
		deletedVolumes: deletedVolumes(db, nodeId),
		...backupJobs(db, nodeId),
		queries: pendingQueries(nodeId),
		mesh,
		ingress: { httpPort: settings.ingressPort, tls: usesTls(settings), routes }
	};
	const revision = createHash('sha256').update(JSON.stringify(document)).digest('hex').slice(0, 16);
	return { revision, ...document };
}
