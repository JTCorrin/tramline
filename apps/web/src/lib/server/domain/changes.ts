import { randomBytes } from 'node:crypto';
import {
	DEFAULT_SERVICE_CONFIG,
	parseReferences,
	type Deployment,
	type StagedChanges
} from '@tramline/contracts';
import { and, eq } from 'drizzle-orm';
import { AppError } from '../api/errors';
import type { DbOrTx } from '../db/client';
import type { Secrets } from '../crypto';
import { deployment, service, serviceInstance, stagedChange, variable } from '../db/schema';
import { publish } from '../events';
import { newId } from '../ids';
import { notifyNodes } from '../nodes/bus';
import { systemLog } from '../nodes/logs';
import type { PlatformSettings } from '../settings';
import { requireEnvironment } from './access';
import type { Ctx } from './context';
import { toDto as deploymentDto } from './deployments';
import { builtinVariables, resolveVariables } from './resolve';
import { describeConfigChanges, scopeOf } from './staging';
import { hasStaged, loadEnvironmentState } from './state';

export function summary(ctx: Ctx, environmentId: string): StagedChanges {
	const env = requireEnvironment(ctx, environmentId);
	const state = loadEnvironmentState(ctx.db, ctx.secrets, env);
	const changes: StagedChanges['changes'] = [];

	if (hasStaged(state.shared.staged)) {
		changes.push({
			serviceId: null,
			label: 'Shared variables',
			details: describeVariables(state.shared.applied, state.shared.effective)
		});
	}
	for (const svc of state.services) {
		if (!hasStaged(svc.staged)) continue;
		changes.push({
			serviceId: svc.service.id,
			label: svc.service.name,
			details: [
				...(svc.staged.create ? ['New service'] : []),
				...describeConfigChanges(svc.applied ?? DEFAULT_SERVICE_CONFIG, svc.effective),
				...describeVariables(svc.appliedVariables, svc.effectiveVariables)
			]
		});
	}
	return { environmentId, count: changes.length, changes };
}

/**
 * Drops every staged change in the environment. Services that were created
 * but never deployed anywhere are removed entirely.
 */
export function discard(ctx: Ctx, environmentId: string) {
	const env = requireEnvironment(ctx, environmentId);
	ctx.db.transaction((tx) => {
		const rows = tx
			.select()
			.from(stagedChange)
			.where(eq(stagedChange.environmentId, environmentId))
			.all();
		for (const row of rows) {
			if (row.payload.create && row.serviceId && neverDeployed(tx, row.serviceId)) {
				tx.delete(service).where(eq(service.id, row.serviceId)).run();
			}
		}
		tx.delete(stagedChange).where(eq(stagedChange.environmentId, environmentId)).run();
	});
	publish({ type: 'services', projectId: env.projectId });
	publish({ type: 'changes', projectId: env.projectId, environmentId });
}

/**
 * Applies the environment's staged changes and queues a deployment for every
 * affected service that has a source. Fails without changing anything when
 * variable references form a cycle.
 */
export function deploy(ctx: Ctx, environmentId: string): Deployment[] {
	const env = requireEnvironment(ctx, environmentId);
	const state = loadEnvironmentState(ctx.db, ctx.secrets, env);

	const changedShared = changedKeys(state.shared.applied, state.shared.effective);
	const affected = state.services.filter(
		(svc) => hasStaged(svc.staged) || usesShared(svc.effectiveVariables, changedShared)
	);
	if (!affected.length && !hasStaged(state.shared.staged)) {
		throw new AppError('conflict', 'There are no changes to deploy');
	}

	for (const svc of affected) {
		const { publicDomain, port } = svc.effective.networking;
		if (publicDomain && !port) {
			throw new AppError(
				'conflict',
				`Set a port on ${svc.service.name} to give it a public domain`
			);
		}
	}

	// generated once per service and environment, then kept for every later deploy
	const domains = new Map(
		state.services.map((svc) => [
			svc.service.id,
			svc.domain ??
				(svc.effective.networking.publicDomain
					? generateDomain(svc.service.name, ctx.settings)
					: null)
		])
	);

	const { variables } = resolveVariables({
		shared: state.shared.effective,
		services: state.services.map((svc) => ({
			id: svc.service.id,
			name: svc.service.name,
			variables: svc.effectiveVariables,
			builtins: builtinVariables(
				svc.service,
				env,
				svc.effective.networking.port,
				domains.get(svc.service.id) ?? null
			)
		}))
	});

	const created = ctx.db.transaction((tx) => {
		replaceVariables(tx, ctx.secrets, environmentId, null, state.shared.effective);
		for (const svc of state.services) {
			if (!hasStaged(svc.staged)) continue;
			tx.update(serviceInstance)
				.set({ config: svc.effective })
				.where(
					and(
						eq(serviceInstance.serviceId, svc.service.id),
						eq(serviceInstance.environmentId, environmentId)
					)
				)
				.run();
			replaceVariables(tx, ctx.secrets, environmentId, svc.service.id, svc.effectiveVariables);
		}
		for (const svc of state.services) {
			const domain = domains.get(svc.service.id);
			if (domain && domain !== svc.domain) {
				tx.update(serviceInstance)
					.set({ domain })
					.where(
						and(
							eq(serviceInstance.serviceId, svc.service.id),
							eq(serviceInstance.environmentId, environmentId)
						)
					)
					.run();
			}
		}
		tx.delete(stagedChange).where(eq(stagedChange.environmentId, environmentId)).run();

		return affected
			.filter((svc) => svc.effective.source)
			.map((svc) =>
				tx
					.insert(deployment)
					.values({
						id: newId('deployment'),
						serviceId: svc.service.id,
						environmentId,
						status: 'queued',
						config: svc.effective,
						variables: ctx.secrets.encrypt(JSON.stringify(variables.get(svc.service.id) ?? {})),
						createdBy: ctx.userId
					})
					.returning()
					.get()
			);
	});

	for (const dep of created) systemLog(ctx.settings.dataDir, dep.id, 'Queued');
	notifyNodes();
	publish({ type: 'changes', projectId: env.projectId, environmentId });
	publish({ type: 'deployments', projectId: env.projectId, environmentId });
	publish({ type: 'services', projectId: env.projectId });
	return created.map(deploymentDto);
}

function neverDeployed(db: DbOrTx, serviceId: string) {
	const applied = db
		.select({ config: serviceInstance.config })
		.from(serviceInstance)
		.where(eq(serviceInstance.serviceId, serviceId))
		.all()
		.some((row) => row.config !== null);
	const deployed = db
		.select({ id: deployment.id })
		.from(deployment)
		.where(eq(deployment.serviceId, serviceId))
		.get();
	return !applied && !deployed;
}

function replaceVariables(
	db: DbOrTx,
	secrets: Secrets,
	environmentId: string,
	serviceId: string | null,
	values: Record<string, string>
) {
	const scope = scopeOf(serviceId);
	db.delete(variable)
		.where(and(eq(variable.environmentId, environmentId), eq(variable.scope, scope)))
		.run();
	for (const [key, value] of Object.entries(values)) {
		db.insert(variable)
			.values({
				id: newId('variable'),
				environmentId,
				serviceId,
				scope,
				key,
				value: secrets.encrypt(value)
			})
			.run();
	}
}

function changedKeys(before: Record<string, string>, after: Record<string, string>) {
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	return new Set([...keys].filter((key) => before[key] !== after[key]));
}

function usesShared(variables: Record<string, string>, keys: Set<string>) {
	if (!keys.size) return false;
	return Object.values(variables).some((value) =>
		parseReferences(value).some((ref) => ref.namespace === 'shared' && keys.has(ref.key))
	);
}

function describeVariables(before: Record<string, string>, after: Record<string, string>) {
	return [...changedKeys(before, after)]
		.sort()
		.map((key) => (!(key in before) ? `+ ${key}` : !(key in after) ? `- ${key}` : `~ ${key}`));
}

/** e.g. `whoami-k3f9x2.localhost` */
function generateDomain(serviceName: string, settings: PlatformSettings) {
	const slug = serviceName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40);
	const suffix = randomBytes(4).toString('hex').slice(0, 6);
	return `${slug || 'service'}-${suffix}.${settings.baseDomain}`;
}
