import type { Deployment } from '@tramline/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { AppError, notFound } from '../api/errors';
import { deployment, project, service } from '../db/schema';
import { publish } from '../events';
import { newId } from '../ids';
import { notifyNodes } from '../nodes/bus';
import { systemLog } from '../nodes/logs';
import type { DbOrTx } from '../db/client';
import { requireInstance } from './access';
import type { Ctx } from './context';
import { sourceLabel } from './staging';

type DeploymentRow = typeof deployment.$inferSelect;

export const toDto = (row: DeploymentRow): Deployment => ({
	id: row.id,
	serviceId: row.serviceId,
	environmentId: row.environmentId,
	status: row.status,
	source: sourceLabel(row.config),
	message: row.message,
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
		.map(toDto);
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
	return toDto(requireDeployment(ctx, id).deployment);
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
