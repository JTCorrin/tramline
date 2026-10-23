import {
	DEFAULT_SERVICE_CONFIG,
	type CreateService,
	type Service,
	type ServiceConfig,
	type ServiceConfigPatch,
	type ServiceConfigView,
	type UpdateService
} from '@tramline/contracts';
import { asc, eq } from 'drizzle-orm';
import { AppError } from '../api/errors';
import { environment, service, serviceInstance } from '../db/schema';
import { publish } from '../events';
import { newId } from '../ids';
import { requireInstance, requireProject, requireService } from './access';
import type { Ctx } from './context';
import { appliedConfig, diffConfig, effectiveConfig, getStaged, saveStaged } from './staging';
import { DATABASE_TEMPLATES } from './templates';

type ServiceRow = typeof service.$inferSelect;

export const toDto = (row: ServiceRow): Service => ({
	id: row.id,
	projectId: row.projectId,
	name: row.name,
	kind: row.kind,
	icon: row.icon,
	position: { x: row.positionX, y: row.positionY },
	createdAt: row.createdAt.toISOString(),
	updatedAt: row.updatedAt.toISOString()
});

export function list(ctx: Ctx, projectId: string): Service[] {
	requireProject(ctx, projectId);
	return ctx.db
		.select()
		.from(service)
		.where(eq(service.projectId, projectId))
		.orderBy(asc(service.createdAt), asc(service.id))
		.all()
		.map(toDto);
}

export function get(ctx: Ctx, id: string): Service {
	return toDto(requireService(ctx, id));
}

export function create(ctx: Ctx, input: CreateService): Service {
	requireProject(ctx, input.projectId);

	let config: ServiceConfig = { ...DEFAULT_SERVICE_CONFIG, source: input.source ?? null };
	let variables: () => Record<string, string> = () => ({});
	let suggested = nameFromSource(input);
	let icon: string | null = null;

	if (input.kind === 'database') {
		if (!input.engine) throw new AppError('validation_failed', 'Choose a database engine');
		const template = DATABASE_TEMPLATES[input.engine];
		config = template.config;
		variables = template.variables;
		suggested = template.name;
		icon = input.engine;
	} else if (
		(input.kind === 'image' || input.kind === 'repo') &&
		input.source?.type !== input.kind
	) {
		throw new AppError('validation_failed', `A ${input.kind} service needs a ${input.kind} source`);
	}

	const name = input.name ?? uniqueName(ctx, input.projectId, suggested);
	const created = ctx.db.transaction((tx) => {
		const row = tx
			.insert(service)
			.values({
				id: newId('service'),
				projectId: input.projectId,
				name,
				kind: input.kind,
				icon,
				positionX: input.position?.x ?? 0,
				positionY: input.position?.y ?? 0
			})
			.returning()
			.get();

		// the service exists everywhere at once; each environment deploys it when its changes are applied
		const environments = tx
			.select({ id: environment.id })
			.from(environment)
			.where(eq(environment.projectId, input.projectId))
			.all();
		for (const env of environments) {
			tx.insert(serviceInstance).values({ serviceId: row.id, environmentId: env.id }).run();
			const set = Object.fromEntries(
				Object.entries(variables()).map(([key, value]) => [key, ctx.secrets.encrypt(value)])
			);
			saveStaged(tx, env.id, row.id, {
				create: true,
				config: diffConfig(DEFAULT_SERVICE_CONFIG, config),
				variables: { set, unset: [] }
			});
		}
		return row;
	});

	publish({ type: 'services', projectId: input.projectId, serviceId: created.id });
	publish({ type: 'changes', projectId: input.projectId });
	return toDto(created);
}

export function update(ctx: Ctx, id: string, patch: UpdateService): Service {
	const current = requireService(ctx, id);
	if (patch.name && patch.name !== current.name && nameTaken(ctx, current.projectId, patch.name)) {
		throw new AppError('conflict', `A service named ${patch.name} already exists`);
	}
	const row = ctx.db
		.update(service)
		.set({
			name: patch.name,
			icon: patch.icon,
			positionX: patch.position?.x,
			positionY: patch.position?.y
		})
		.where(eq(service.id, id))
		.returning()
		.get()!;
	publish({ type: 'services', projectId: row.projectId, serviceId: id });
	return toDto(row);
}

export function remove(ctx: Ctx, id: string) {
	const current = requireService(ctx, id);
	ctx.db.delete(service).where(eq(service.id, id)).run();
	publish({ type: 'services', projectId: current.projectId, serviceId: id });
	publish({ type: 'changes', projectId: current.projectId });
}

// ---- per-environment configuration -------------------------------------------

export function getConfig(ctx: Ctx, serviceId: string, environmentId: string): ServiceConfigView {
	requireInstance(ctx, serviceId, environmentId);
	return configView(ctx, serviceId, environmentId);
}

/** Stages a config change; it takes effect on the next deploy of the environment. */
export function stageConfig(
	ctx: Ctx,
	serviceId: string,
	environmentId: string,
	patch: ServiceConfigPatch
): ServiceConfigView {
	const { service: svc } = requireInstance(ctx, serviceId, environmentId);
	const applied = appliedConfig(ctx.db, serviceId, environmentId);
	const staged = getStaged(ctx.db, environmentId, serviceId);
	const next = effectiveConfig(applied, { config: { ...staged.config } });
	const target = effectiveConfig(next, { config: patch });

	saveStaged(ctx.db, environmentId, serviceId, {
		...staged,
		config: diffConfig(applied ?? DEFAULT_SERVICE_CONFIG, target)
	});

	publish({ type: 'config', projectId: svc.projectId, environmentId, serviceId });
	publish({ type: 'changes', projectId: svc.projectId, environmentId });
	return configView(ctx, serviceId, environmentId);
}

function configView(ctx: Ctx, serviceId: string, environmentId: string): ServiceConfigView {
	const applied = appliedConfig(ctx.db, serviceId, environmentId);
	const staged = getStaged(ctx.db, environmentId, serviceId);
	return {
		applied,
		effective: effectiveConfig(applied, staged),
		staged: Boolean(staged.create || (staged.config && Object.keys(staged.config).length))
	};
}

// ---- naming ----------------------------------------------------------------------

function nameFromSource(input: CreateService) {
	const source = input.source;
	if (!source) return 'service';
	// ghcr.io/acme/api:1.2 → api, https://github.com/acme/web.git → web
	const raw =
		source.type === 'image'
			? source.image.split('@')[0]!.split('/').pop()!.split(':')[0]!
			: source.repo
					.replace(/\.git$/, '')
					.split('/')
					.filter(Boolean)
					.pop()!;
	return raw.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'service';
}

function nameTaken(ctx: Ctx, projectId: string, name: string) {
	return ctx.db
		.select({ name: service.name })
		.from(service)
		.where(eq(service.projectId, projectId))
		.all()
		.some((row) => row.name.toLowerCase() === name.toLowerCase());
}

function uniqueName(ctx: Ctx, projectId: string, base: string) {
	const trimmed = base.slice(0, 44);
	let name = trimmed;
	for (let n = 2; nameTaken(ctx, projectId, name); n++) name = `${trimmed}-${n}`;
	return name;
}
