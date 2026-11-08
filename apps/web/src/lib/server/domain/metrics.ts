import { MetricRange, type Alert, type SecurityEvent } from '@tramline/contracts';
import { and, desc, eq, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { AppError, notFound } from '../api/errors';
import { alert, node, project, securityEvent, service } from '../db/schema';
import { toAlert } from '../metrics/alerts';
import * as store from '../metrics/store';
import { requireInstance } from './access';
import type { Ctx } from './context';

function range(value: string | null): MetricRange {
	const parsed = MetricRange.safeParse(value ?? '1h');
	if (!parsed.success) {
		throw new AppError('bad_request', `range must be one of ${MetricRange.options.join(', ')}`);
	}
	return parsed.data;
}

export function serviceMetrics(
	ctx: Ctx,
	serviceId: string,
	environmentId: string,
	rangeParam: string | null
) {
	requireInstance(ctx, serviceId, environmentId);
	return store.serviceMetrics(ctx.db, serviceId, environmentId, range(rangeParam));
}

/**
 * What a service's containers tried that containment blocked, newest first,
 * over the last week: for its organization only.
 */
export function securityEvents(
	ctx: Ctx,
	serviceId: string,
	environmentId: string,
	now = Date.now()
): SecurityEvent[] {
	requireInstance(ctx, serviceId, environmentId);
	return ctx.db
		.select({
			deploymentId: securityEvent.deploymentId,
			nodeId: securityEvent.nodeId,
			nodeName: node.name,
			kind: securityEvent.kind,
			count: securityEvent.count,
			bucket: securityEvent.bucket
		})
		.from(securityEvent)
		.leftJoin(node, eq(node.id, securityEvent.nodeId))
		.where(
			and(
				eq(securityEvent.serviceId, serviceId),
				eq(securityEvent.environmentId, environmentId),
				gte(securityEvent.bucket, new Date(now - 7 * 86_400_000))
			)
		)
		.orderBy(desc(securityEvent.bucket))
		.limit(500)
		.all()
		.map(({ bucket, ...e }) => ({ ...e, at: bucket.toISOString() }));
}

/** Nodes are shared by every organization on the install, and so are their metrics. */
export function nodeMetrics(ctx: Ctx, nodeId: string, rangeParam: string | null) {
	const found = ctx.db.select({ id: node.id }).from(node).where(eq(node.id, nodeId)).get();
	if (!found) throw notFound('Node');
	return store.nodeMetrics(ctx.db, nodeId, range(rangeParam));
}

/**
 * Open alerts, and those resolved in the last day: the install's node alerts,
 * and alerts for this organization's services.
 */
export function listAlerts(ctx: Ctx, now = Date.now()): Alert[] {
	const services = ctx.db
		.select({ id: service.id })
		.from(service)
		.innerJoin(project, eq(service.projectId, project.id))
		.where(eq(project.organizationId, ctx.organizationId));
	return ctx.db
		.select()
		.from(alert)
		.where(
			and(
				or(isNotNull(alert.nodeId), inArray(alert.serviceId, services)),
				or(isNull(alert.resolvedAt), gte(alert.resolvedAt, new Date(now - 86_400_000)))
			)
		)
		.orderBy(desc(alert.openedAt))
		.limit(200)
		.all()
		.map(toAlert);
}
