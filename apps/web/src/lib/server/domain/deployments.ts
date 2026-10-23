import type { Deployment } from '@tramline/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { deployment } from '../db/schema';
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
