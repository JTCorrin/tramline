import type { CreateProject, Project, UpdateProject } from '@tramline/contracts';
import { and, asc, eq } from 'drizzle-orm';
import { notFound } from '../api/errors';
import { project } from '../db/schema';
import { newId } from '../ids';
import type { Ctx } from './context';

type ProjectRow = typeof project.$inferSelect;

const toDto = (row: ProjectRow): Project => ({
	id: row.id,
	organizationId: row.organizationId,
	name: row.name,
	description: row.description,
	createdAt: row.createdAt.toISOString(),
	updatedAt: row.updatedAt.toISOString()
});

const scoped = (ctx: Ctx, id: string) =>
	and(eq(project.id, id), eq(project.organizationId, ctx.organizationId));

export function list(ctx: Ctx): Project[] {
	return ctx.db
		.select()
		.from(project)
		.where(eq(project.organizationId, ctx.organizationId))
		.orderBy(asc(project.createdAt), asc(project.id))
		.all()
		.map(toDto);
}

export function get(ctx: Ctx, id: string): Project {
	const row = ctx.db.select().from(project).where(scoped(ctx, id)).get();
	if (!row) throw notFound('Project');
	return toDto(row);
}

export function create(ctx: Ctx, input: CreateProject): Project {
	const row = ctx.db
		.insert(project)
		.values({
			id: newId('project'),
			organizationId: ctx.organizationId,
			name: input.name,
			description: input.description || null
		})
		.returning()
		.get();
	return toDto(row);
}

export function update(ctx: Ctx, id: string, patch: UpdateProject): Project {
	if (Object.keys(patch).length === 0) return get(ctx, id);

	const row = ctx.db
		.update(project)
		.set({ ...patch, description: patch.description === '' ? null : patch.description })
		.where(scoped(ctx, id))
		.returning()
		.get();
	if (!row) throw notFound('Project');
	return toDto(row);
}

export function remove(ctx: Ctx, id: string): void {
	const deleted = ctx.db.delete(project).where(scoped(ctx, id)).returning({ id: project.id }).get();
	if (!deleted) throw notFound('Project');
}
