import { and, eq } from 'drizzle-orm';
import { notFound } from '../api/errors';
import { environment, project, service } from '../db/schema';
import type { Ctx } from './context';

// Every lookup joins through `project` so callers can only reach their organization's data.

export function requireProject(ctx: Ctx, projectId: string) {
	const row = ctx.db
		.select()
		.from(project)
		.where(and(eq(project.id, projectId), eq(project.organizationId, ctx.organizationId)))
		.get();
	if (!row) throw notFound('Project');
	return row;
}

export function requireEnvironment(ctx: Ctx, environmentId: string) {
	const row = ctx.db
		.select({ environment })
		.from(environment)
		.innerJoin(project, eq(environment.projectId, project.id))
		.where(and(eq(environment.id, environmentId), eq(project.organizationId, ctx.organizationId)))
		.get();
	if (!row) throw notFound('Environment');
	return row.environment;
}

export function requireService(ctx: Ctx, serviceId: string) {
	const row = ctx.db
		.select({ service })
		.from(service)
		.innerJoin(project, eq(service.projectId, project.id))
		.where(and(eq(service.id, serviceId), eq(project.organizationId, ctx.organizationId)))
		.get();
	if (!row) throw notFound('Service');
	return row.service;
}

/** Loads a service and an environment, checking they belong to the same project. */
export function requireInstance(ctx: Ctx, serviceId: string, environmentId: string) {
	const svc = requireService(ctx, serviceId);
	const env = requireEnvironment(ctx, environmentId);
	if (svc.projectId !== env.projectId) throw notFound('Environment');
	return { service: svc, environment: env };
}
