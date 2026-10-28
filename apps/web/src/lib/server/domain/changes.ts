import { randomBytes } from 'node:crypto';
import { DEFAULT_SERVICE_CONFIG, type Deployment, type StagedChanges } from '@tramline/contracts';
import { and, eq, isNotNull } from 'drizzle-orm';
import { parseCron } from '../cron';
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
import { pruneSeals, sealedKeys } from './variables';
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
	// services that change only because something they use changed
	let changed = new Map<string, string[]>();
	try {
		changed = plan(ctx, env, state).changed;
	} catch {
		// a reference loop: deploying will say so
	}
	for (const svc of state.services) {
		if (!hasStaged(svc.staged)) {
			const keys = changed.get(svc.service.id);
			if (keys && svc.effective.source) {
				changes.push({
					serviceId: svc.service.id,
					label: svc.service.name,
					details: [`Redeploys with new values: ${keys.join(', ')}`]
				});
			}
			continue;
		}
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
		pruneSeals(tx, ctx.secrets, environmentId, null);
		for (const row of rows)
			if (row.serviceId) pruneSeals(tx, ctx.secrets, environmentId, row.serviceId);
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

	const { affected, after, domains } = plan(ctx, env, state);
	if (!affected.length && !hasStaged(state.shared.staged)) {
		throw new AppError('conflict', 'There are no changes to deploy');
	}

	for (const svc of affected) {
		const schedule = svc.effective.deploy.cronSchedule;
		if (schedule) {
			try {
				parseCron(schedule);
			} catch (error) {
				throw new AppError(
					'conflict',
					`${svc.service.name}'s cron schedule: ${(error as Error).message}`
				);
			}
		}
		const networking = svc.effective.networking;
		if (networking.tcpProxy) {
			if (svc.service.kind !== 'database' || svc.service.icon !== 'postgres') {
				throw new AppError(
					'conflict',
					`${svc.service.name}: the TCP proxy supports Postgres only, for now`
				);
			}
			if (!networking.tcpAllowlist.length) {
				throw new AppError(
					'conflict',
					`${svc.service.name}: list the addresses the TCP proxy should let in (0.0.0.0/0 for anyone)`
				);
			}
		}
		if (svc.effective.volume?.mountPath && svc.effective.deploy.replicas > 1) {
			// replicas would share one directory, which corrupts most databases
			throw new AppError(
				'conflict',
				`${svc.service.name} has a volume, so it runs a single replica`
			);
		}
		const { publicDomain, port } = svc.effective.networking;
		if (publicDomain && !port) {
			throw new AppError(
				'conflict',
				`Set a port on ${svc.service.name} to give it a public domain`
			);
		}
	}

	const { variables, sensitive } = after;

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
		for (const svc of state.services) {
			if (svc.effective.networking.tcpProxy) assignTcpPort(tx, svc.service.id, environmentId);
		}
		tx.delete(stagedChange).where(eq(stagedChange.environmentId, environmentId)).run();
		pruneSeals(tx, ctx.secrets, environmentId, null);
		for (const svc of state.services) pruneSeals(tx, ctx.secrets, environmentId, svc.service.id);

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
						sensitiveKeys: [...(sensitive.get(svc.service.id) ?? [])].sort(),
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
	return created.map((row) => deploymentDto(row));
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

type EnvironmentState = ReturnType<typeof loadEnvironmentState>;

/** Sealed variables in the environment, as `shared.KEY` and `ServiceName.KEY`. */
function sealedIds(ctx: Ctx, env: { id: string }, state: EnvironmentState) {
	return new Set([
		...[...sealedKeys(ctx.db, env.id, null)].map((key) => `shared.${key}`),
		...state.services.flatMap((svc) =>
			[...sealedKeys(ctx.db, env.id, svc.service.id)].map((key) => `${svc.service.name}.${key}`)
		)
	]);
}

/**
 * What deploying the environment would change. A service is affected when it
 * has staged changes, or when its resolved variables differ from its last
 * deploy: through a shared variable, another service's variable, a chain of
 * references, or a built-in like a new domain. Throws on reference loops.
 */
function plan(ctx: Ctx, env: { id: string; name: string }, state: EnvironmentState) {
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
	const sealed = sealedIds(ctx, env, state);
	const after = resolveVariables({
		shared: state.shared.effective,
		sealed,
		services: state.services.map((svc) => ({
			id: svc.service.id,
			name: svc.service.name,
			variables: svc.effectiveVariables,
			builtins: builtinVariables(
				svc.service,
				env,
				svc.effective.networking.port,
				domains.get(svc.service.id) ?? null,
				svc.effective.volume?.mountPath ?? null
			)
		}))
	});
	let before: Map<string, Record<string, string>> | null = null;
	try {
		before = resolveVariables({
			shared: state.shared.applied,
			services: state.services.map((svc) => ({
				id: svc.service.id,
				name: svc.service.name,
				variables: svc.appliedVariables,
				builtins: builtinVariables(
					svc.service,
					env,
					svc.applied?.networking.port ?? null,
					svc.domain,
					svc.applied?.volume?.mountPath ?? null
				)
			}))
		}).variables;
	} catch {
		// what's deployed can't be resolved again (e.g. a loop since fixed): treat all as changed
	}
	const changed = new Map<string, string[]>();
	for (const svc of state.services) {
		if (!svc.applied) continue;
		const keys = [
			...changedKeys(before?.get(svc.service.id) ?? {}, after.variables.get(svc.service.id) ?? {})
		].sort();
		if (keys.length) changed.set(svc.service.id, keys);
	}
	const affected = state.services.filter(
		(svc) => hasStaged(svc.staged) || changed.has(svc.service.id)
	);
	return { affected, after, domains, changed };
}

function changedKeys(before: Record<string, string>, after: Record<string, string>) {
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	return new Set([...keys].filter((key) => before[key] !== after[key]));
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

/** The first edge port for TCP proxies; ports are kept once assigned. */
export const TCP_PORTS = { first: 30_000, last: 32_767 };

/** Gives a service its TCP proxy port the first time it's deployed with one. */
function assignTcpPort(tx: DbOrTx, serviceId: string, environmentId: string) {
	const where = and(
		eq(serviceInstance.serviceId, serviceId),
		eq(serviceInstance.environmentId, environmentId)
	);
	if (tx.select({ port: serviceInstance.tcpPort }).from(serviceInstance).where(where).get()?.port)
		return;
	const taken = new Set(
		tx
			.select({ port: serviceInstance.tcpPort })
			.from(serviceInstance)
			.where(isNotNull(serviceInstance.tcpPort))
			.all()
			.map((row) => row.port)
	);
	for (let port = TCP_PORTS.first; port <= TCP_PORTS.last; port++) {
		if (taken.has(port)) continue;
		tx.update(serviceInstance).set({ tcpPort: port }).where(where).run();
		return;
	}
	throw new AppError('conflict', 'Every TCP proxy port is in use');
}
