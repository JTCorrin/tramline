import {
	DEFAULT_SERVICE_CONFIG,
	mergeConfig,
	type Deployment,
	type ServiceConfig
} from '@tramline/contracts';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { Secrets } from '../crypto';
import type { Db } from '../db/client';
import { deployment, environment, project, service, serviceInstance } from '../db/schema';
import { publish } from '../events';
import { newId } from '../ids';
import { notifyNodes } from '../nodes/bus';
import { systemLog } from '../nodes/logs';
import type { PlatformSettings } from '../settings';
import { toDto } from './deployments';
import { builtinVariables, resolveVariables } from './resolve';
import { loadEnvironmentState } from './state';

/** A deployed service instance whose source is a repository branch with deploy-on-push on. */
export interface TrackedInstance {
	serviceId: string;
	environmentId: string;
	projectId: string;
	organizationId: string;
	config: ServiceConfig & { source: Extract<ServiceConfig['source'], { type: 'repo' }> };
	/** The commit of its most recent deployment, if any. */
	latestCommit: string | null;
}

export function trackedInstances(db: Db): TrackedInstance[] {
	const rows = db
		.select({
			serviceId: serviceInstance.serviceId,
			environmentId: serviceInstance.environmentId,
			projectId: service.projectId,
			organizationId: project.organizationId,
			config: serviceInstance.config
		})
		.from(serviceInstance)
		.innerJoin(service, eq(service.id, serviceInstance.serviceId))
		.innerJoin(project, eq(project.id, service.projectId))
		.where(isNotNull(serviceInstance.config))
		.all();
	return rows.flatMap((row) => {
		const config = mergeConfig(DEFAULT_SERVICE_CONFIG, row.config!);
		if (config.source?.type !== 'repo' || config.source.autoDeploy === false) return [];
		const latest = db
			.select({ commit: deployment.commit })
			.from(deployment)
			.where(
				and(
					eq(deployment.serviceId, row.serviceId),
					eq(deployment.environmentId, row.environmentId)
				)
			)
			.orderBy(desc(deployment.createdAt), desc(deployment.id))
			.get();
		return [
			{ ...row, config: config as TrackedInstance['config'], latestCommit: latest?.commit ?? null }
		];
	});
}

/** A gitignore-style pattern as a regular expression over repository paths. */
function globRegex(pattern: string) {
	let glob = pattern.replace(/^\/+/, '');
	// like .gitignore, a pattern without a slash matches at any depth
	if (!pattern.includes('/') || pattern.endsWith('/')) glob = `**/${glob}`;
	if (glob.endsWith('/')) glob += '**';
	let source = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (glob.startsWith('**/', i)) {
			source += '(?:.*/)?';
			i += 2;
		} else if (glob.startsWith('**', i)) {
			source += '.*';
			i += 1;
		} else if (c === '*') source += '[^/]*';
		else if (c === '?') source += '[^/]';
		else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${source}(?:/.*)?$`);
}

/**
 * Whether any changed file matches the watch paths. Patterns apply in order
 * and the last one matching a file decides, so `!` excludes (e.g. `src/**`
 * then `!**\/*.md`). No patterns means every change counts.
 */
export function touchesWatchPaths(files: string[], patterns: string[]) {
	if (!patterns.length) return true;
	const rules = patterns.map((p) =>
		p.startsWith('!')
			? { include: false, re: globRegex(p.slice(1)) }
			: { include: true, re: globRegex(p) }
	);
	return files.some((file) => {
		let included = false;
		for (const rule of rules) if (rule.re.test(file)) included = rule.include;
		return included;
	});
}

/** Whether a push touching `files` should deploy the service. */
export const wantsDeploy = (files: string[], config: ServiceConfig) =>
	config.source?.type === 'repo' &&
	touchesRoot(files, config.source.rootDirectory) &&
	touchesWatchPaths(files, config.build.watchPaths ?? []);

/** Whether any changed file is inside the service's root directory. */
export function touchesRoot(files: string[], rootDirectory: string) {
	const root = rootDirectory.replace(/^\/+|\/+$/g, '');
	if (!root) return true;
	return files.some((file) => file === root || file.startsWith(`${root}/`));
}

/**
 * Deploys `commit` of an instance's repository using what is deployed now
 * (config and variables). Staged edits stay staged, as if someone pressed
 * Redeploy on a new commit.
 */
export function deployCommit(
	db: Db,
	secrets: Secrets,
	settings: PlatformSettings,
	target: Pick<TrackedInstance, 'serviceId' | 'environmentId' | 'projectId'>,
	commit: string,
	reason: string
): Deployment {
	const env = db.select().from(environment).where(eq(environment.id, target.environmentId)).get()!;
	const state = loadEnvironmentState(db, secrets, env);
	const { variables } = resolveVariables({
		shared: state.shared.applied,
		services: state.services.map((svc) => {
			const config = svc.applied ?? DEFAULT_SERVICE_CONFIG;
			return {
				id: svc.service.id,
				name: svc.service.name,
				variables: svc.appliedVariables,
				builtins: builtinVariables(
					svc.service,
					env,
					config.networking.port,
					svc.domain,
					config.volume?.mountPath ?? null
				)
			};
		})
	});
	const svc = state.services.find((s) => s.service.id === target.serviceId)!;
	const row = db
		.insert(deployment)
		.values({
			id: newId('deployment'),
			serviceId: target.serviceId,
			environmentId: target.environmentId,
			status: 'queued',
			config: svc.applied!,
			variables: secrets.encrypt(JSON.stringify(variables.get(target.serviceId) ?? {})),
			commit,
			createdBy: null
		})
		.returning()
		.get();
	systemLog(settings.dataDir, row.id, reason);
	notifyNodes();
	publish({
		type: 'deployments',
		projectId: target.projectId,
		environmentId: target.environmentId
	});
	return toDto(row);
}
