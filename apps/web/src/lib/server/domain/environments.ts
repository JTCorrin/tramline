import {
	DEFAULT_SERVICE_CONFIG,
	type CreateEnvironment,
	type Environment,
	type UpdateEnvironment
} from '@tramline/contracts';
import { asc, eq } from 'drizzle-orm';
import { AppError } from '../api/errors';
import type { DbOrTx } from '../db/client';
import { environment, service, serviceInstance } from '../db/schema';
import { publish } from '../events';
import { newId } from '../ids';
import { requireEnvironment, requireProject } from './access';
import type { Ctx } from './context';
import { appliedConfig, diffConfig, effectiveConfig, getStaged, saveStaged } from './staging';

type EnvironmentRow = typeof environment.$inferSelect;

const toDto = (row: EnvironmentRow): Environment => ({
	id: row.id,
	projectId: row.projectId,
	name: row.name,
	createdAt: row.createdAt.toISOString()
});

const all = (db: DbOrTx, projectId: string) =>
	db
		.select()
		.from(environment)
		.where(eq(environment.projectId, projectId))
		.orderBy(asc(environment.createdAt), asc(environment.id))
		.all();

export function list(ctx: Ctx, projectId: string): Environment[] {
	requireProject(ctx, projectId);
	return all(ctx.db, projectId).map(toDto);
}

export function get(ctx: Ctx, id: string): Environment {
	return toDto(requireEnvironment(ctx, id));
}

/** Inserts the default `production` environment for a new project. */
export function createDefault(db: DbOrTx, projectId: string) {
	db.insert(environment)
		.values({ id: newId('environment'), projectId, name: 'production' })
		.run();
}

/**
 * Creates an environment containing every service, configured like the
 * project's first environment. Nothing runs until its changes are deployed.
 */
export function create(ctx: Ctx, input: CreateEnvironment): Environment {
	requireProject(ctx, input.projectId);
	const existing = all(ctx.db, input.projectId);
	if (existing.some((env) => env.name === input.name)) {
		throw new AppError('conflict', `An environment named ${input.name} already exists`);
	}
	const template = existing[0];

	const created = ctx.db.transaction((tx) => {
		const row = tx
			.insert(environment)
			.values({ id: newId('environment'), projectId: input.projectId, name: input.name })
			.returning()
			.get();
		const services = tx
			.select({ id: service.id })
			.from(service)
			.where(eq(service.projectId, input.projectId))
			.all();
		for (const svc of services) {
			tx.insert(serviceInstance).values({ serviceId: svc.id, environmentId: row.id }).run();
			const config = template
				? effectiveConfig(
						appliedConfig(tx, svc.id, template.id),
						getStaged(tx, template.id, svc.id)
					)
				: DEFAULT_SERVICE_CONFIG;
			saveStaged(tx, row.id, svc.id, {
				create: true,
				config: diffConfig(DEFAULT_SERVICE_CONFIG, config)
			});
		}
		return row;
	});

	publish({ type: 'environments', projectId: input.projectId });
	return toDto(created);
}

export function update(ctx: Ctx, id: string, patch: UpdateEnvironment): Environment {
	const current = requireEnvironment(ctx, id);
	if (all(ctx.db, current.projectId).some((env) => env.name === patch.name && env.id !== id)) {
		throw new AppError('conflict', `An environment named ${patch.name} already exists`);
	}
	const row = ctx.db
		.update(environment)
		.set({ name: patch.name })
		.where(eq(environment.id, id))
		.returning()
		.get()!;
	publish({ type: 'environments', projectId: row.projectId });
	return toDto(row);
}

export function remove(ctx: Ctx, id: string) {
	const current = requireEnvironment(ctx, id);
	if (all(ctx.db, current.projectId).length === 1) {
		throw new AppError('conflict', 'A project needs at least one environment');
	}
	ctx.db.delete(environment).where(eq(environment.id, id)).run();
	publish({ type: 'environments', projectId: current.projectId });
}
