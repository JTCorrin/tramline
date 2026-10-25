import type { CronRun, Deployment } from '@tramline/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { AppError, notFound } from '../api/errors';
import { cronRun, deployment, project, service } from '../db/schema';
import { publish } from '../events';
import { newId } from '../ids';
import { notifyNodes } from '../nodes/bus';
import { isCron, nextRunAt, startRun } from '../nodes/cron';
import { systemLog } from '../nodes/logs';
import type { DbOrTx } from '../db/client';
import { requireInstance } from './access';
import type { Ctx } from './context';
import { deployCommit } from './autodeploy';
import { appliedConfig, sourceLabel } from './staging';

type DeploymentRow = typeof deployment.$inferSelect;

export const toDto = (row: DeploymentRow, nextRunAt: Date | null = null): Deployment => ({
	id: row.id,
	serviceId: row.serviceId,
	environmentId: row.environmentId,
	status: row.status,
	source: sourceLabel(row.config),
	message: row.message,
	commit: row.commit,
	nextRunAt: nextRunAt?.toISOString() ?? null,
	scan: row.scan ?? null,
	createdBy: row.createdBy,
	createdAt: row.createdAt.toISOString(),
	updatedAt: row.updatedAt.toISOString()
});

export function list(ctx: Ctx, query: { serviceId: string; environmentId: string }): Deployment[] {
	requireInstance(ctx, query.serviceId, query.environmentId);
	return ctx.db
		.select()
		.from(deployment)
		.where(
			and(
				eq(deployment.serviceId, query.serviceId),
				eq(deployment.environmentId, query.environmentId)
			)
		)
		.orderBy(desc(deployment.createdAt), desc(deployment.id))
		.limit(50)
		.all()
		.map((row) => toDto(row, nextRunAt(ctx.db, row)));
}

/** A cron deployment's recent runs, newest first. */
export function runs(ctx: Ctx, id: string): CronRun[] {
	requireDeployment(ctx, id);
	return ctx.db
		.select()
		.from(cronRun)
		.where(eq(cronRun.deploymentId, id))
		.orderBy(desc(cronRun.scheduledFor), desc(cronRun.id))
		.limit(30)
		.all()
		.map((run) => ({
			id: run.id,
			deploymentId: run.deploymentId,
			trigger: run.trigger,
			status: run.status,
			exitCode: run.exitCode,
			scheduledFor: run.scheduledFor.toISOString(),
			finishedAt: run.finishedAt?.toISOString() ?? null
		}));
}

/** Starts a cron service's job now, outside its schedule. */
export function runNow(ctx: Ctx, id: string): CronRun {
	const { deployment: dep, projectId } = requireDeployment(ctx, id);
	if (!isCron(dep) || !['active', 'crashed'].includes(dep.status)) {
		throw new AppError('conflict', 'Only a live cron service can be run');
	}
	const run = startRun(ctx.db, ctx.settings.dataDir, dep, 'manual', new Date());
	if (run.status === 'skipped') throw new AppError('conflict', 'A run is already going');
	notifyNodes();
	publish({ type: 'deployments', projectId, environmentId: dep.environmentId });
	return runs(ctx, id).find((r) => r.id === run.id)!;
}

/** Latest deployment status per service in an environment. */
export function latestStatuses(db: DbOrTx, environmentId: string) {
	const statuses = new Map<string, DeploymentRow['status']>();
	const rows = db
		.select({ serviceId: deployment.serviceId, status: deployment.status })
		.from(deployment)
		.where(eq(deployment.environmentId, environmentId))
		.orderBy(desc(deployment.createdAt), desc(deployment.id))
		.all();
	for (const row of rows) if (!statuses.has(row.serviceId)) statuses.set(row.serviceId, row.status);
	return statuses;
}

/** Loads a deployment the caller's organization owns. */
export function requireDeployment(ctx: Ctx, id: string) {
	const row = ctx.db
		.select({ deployment, projectId: service.projectId })
		.from(deployment)
		.innerJoin(service, eq(deployment.serviceId, service.id))
		.innerJoin(project, eq(service.projectId, project.id))
		.where(and(eq(deployment.id, id), eq(project.organizationId, ctx.organizationId)))
		.get();
	if (!row) throw notFound('Deployment');
	return row;
}

export function get(ctx: Ctx, id: string): Deployment {
	const row = requireDeployment(ctx, id).deployment;
	return toDto(row, nextRunAt(ctx.db, row));
}

/**
 * Queues a new deployment with exactly the config and variables of an
 * existing one. Redeploying the latest deployment restarts it; redeploying an
 * older one is a rollback.
 */
export function redeploy(ctx: Ctx, id: string): Deployment {
	const { deployment: source, projectId } = requireDeployment(ctx, id);
	const row = ctx.db
		.insert(deployment)
		.values({
			id: newId('deployment'),
			serviceId: source.serviceId,
			environmentId: source.environmentId,
			status: 'queued',
			config: source.config,
			variables: source.variables,
			// the exact image again: the built one, or the digest the original pulled
			image: source.image ?? source.resolvedImage,
			commit: source.commit,
			// the same image needs no new scan
			scan: (source.image ?? source.resolvedImage) ? source.scan : null,
			createdBy: ctx.userId
		})
		.returning()
		.get();
	systemLog(ctx.settings.dataDir, row.id, `Redeploy of ${source.id}`);
	notifyNodes();
	publish({ type: 'deployments', projectId, environmentId: source.environmentId });
	return toDto(row);
}

/** Stops a deployment and removes its containers. */
export function remove(ctx: Ctx, id: string): Deployment {
	const { deployment: dep, projectId } = requireDeployment(ctx, id);
	if (dep.status === 'removed' || dep.status === 'failed') {
		throw new AppError('conflict', 'This deployment is not running');
	}
	const row = ctx.db
		.update(deployment)
		.set({ status: 'removed', message: 'Removed' })
		.where(eq(deployment.id, id))
		.returning()
		.get()!;
	systemLog(ctx.settings.dataDir, id, 'Removed');
	notifyNodes();
	publish({ type: 'deployments', projectId, environmentId: dep.environmentId });
	return toDto(row);
}

/**
 * Deploys a service as it is deployed now (config and variables; staged
 * edits stay staged), optionally at an exact commit: what CI calls after
 * testing a commit.
 */
export function deployService(
	ctx: Ctx,
	input: { serviceId: string; environmentId: string; commit?: string | null }
): Deployment {
	const { service: svc } = requireInstance(ctx, input.serviceId, input.environmentId);
	const applied = appliedConfig(ctx.db, input.serviceId, input.environmentId);
	if (!applied?.source) {
		throw new AppError('conflict', `Deploy ${svc.name}'s staged changes first`);
	}
	if (input.commit && applied.source.type !== 'repo') {
		throw new AppError('validation_failed', 'Only services built from a repository take a commit');
	}
	const by = ctx.token ? `token “${ctx.token.name}”` : 'hand';
	return deployCommit(
		ctx.db,
		ctx.secrets,
		ctx.settings,
		{ serviceId: input.serviceId, environmentId: input.environmentId, projectId: svc.projectId },
		input.commit ?? null,
		`Deployed${input.commit ? ` ${input.commit.slice(0, 7)}` : ''} by ${by}`,
		ctx.userId
	);
}
