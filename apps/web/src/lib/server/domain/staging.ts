import {
	DEFAULT_SERVICE_CONFIG,
	mergeConfig,
	type ServiceConfig,
	type ServiceConfigPatch
} from '@tramline/contracts';
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { serviceInstance, stagedChange, type StagedPayload } from '../db/schema';
import { newId } from '../ids';

export const scopeOf = (serviceId: string | null) => serviceId ?? 'shared';

export function getStaged(
	db: DbOrTx,
	environmentId: string,
	serviceId: string | null
): StagedPayload {
	return (
		db
			.select({ payload: stagedChange.payload })
			.from(stagedChange)
			.where(
				and(
					eq(stagedChange.environmentId, environmentId),
					eq(stagedChange.scope, scopeOf(serviceId))
				)
			)
			.get()?.payload ?? {}
	);
}

const isEmpty = (payload: StagedPayload) =>
	!payload.create &&
	(!payload.config || Object.keys(payload.config).length === 0) &&
	(!payload.variables ||
		(Object.keys(payload.variables.set).length === 0 && payload.variables.unset.length === 0));

/** Stores the staged payload, or removes it when nothing is left to stage. */
export function saveStaged(
	db: DbOrTx,
	environmentId: string,
	serviceId: string | null,
	payload: StagedPayload
) {
	const scope = scopeOf(serviceId);
	if (isEmpty(payload)) {
		db.delete(stagedChange)
			.where(and(eq(stagedChange.environmentId, environmentId), eq(stagedChange.scope, scope)))
			.run();
		return;
	}
	db.insert(stagedChange)
		.values({ id: newId('change'), environmentId, serviceId, scope, payload })
		.onConflictDoUpdate({
			target: [stagedChange.environmentId, stagedChange.scope],
			set: { payload, updatedAt: new Date() }
		})
		.run();
}

export function appliedConfig(db: DbOrTx, serviceId: string, environmentId: string) {
	const stored =
		db
			.select({ config: serviceInstance.config })
			.from(serviceInstance)
			.where(
				and(
					eq(serviceInstance.serviceId, serviceId),
					eq(serviceInstance.environmentId, environmentId)
				)
			)
			.get()?.config ?? null;
	// configs saved before a field existed pick up its default
	return stored && mergeConfig(DEFAULT_SERVICE_CONFIG, stored);
}

export function effectiveConfig(applied: ServiceConfig | null, staged: StagedPayload) {
	return mergeConfig(applied ?? DEFAULT_SERVICE_CONFIG, staged.config ?? {});
}

const SECTIONS = ['build', 'deploy', 'networking', 'volume'] as const;

/** The smallest patch that turns `base` into `target`. */
export function diffConfig(base: ServiceConfig, target: ServiceConfig): ServiceConfigPatch {
	const patch: ServiceConfigPatch = {};
	if (JSON.stringify(base.source) !== JSON.stringify(target.source)) patch.source = target.source;
	for (const section of SECTIONS) {
		const changed = Object.entries(target[section]).filter(
			([key, value]) => (base[section] as Record<string, unknown>)[key] !== value
		);
		if (changed.length) (patch as Record<string, unknown>)[section] = Object.fromEntries(changed);
	}
	return patch;
}

/** Human readable lines describing how `target` differs from `base`. */
export function describeConfigChanges(base: ServiceConfig, target: ServiceConfig) {
	const show = (value: unknown) => (value === null || value === '' ? '—' : String(value));
	const lines: string[] = [];
	if (JSON.stringify(base.source) !== JSON.stringify(target.source)) {
		lines.push(`source: ${sourceLabel(base) ?? '—'} → ${sourceLabel(target) ?? '—'}`);
	}
	for (const section of SECTIONS) {
		for (const [key, value] of Object.entries(target[section])) {
			const before = (base[section] as Record<string, unknown>)[key];
			if (before !== value) lines.push(`${section}.${key}: ${show(before)} → ${show(value)}`);
		}
	}
	return lines;
}

export function sourceLabel(config: ServiceConfig | null) {
	const source = config?.source;
	if (!source) return null;
	return source.type === 'image' ? source.image : `${source.repo}@${source.branch}`;
}
