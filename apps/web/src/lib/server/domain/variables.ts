import type { StageVariables, Variable } from '@tramline/contracts';
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import type { Secrets } from '../crypto';
import { AppError } from '../api/errors';
import { sealedVariable, variable } from '../db/schema';
import { publish } from '../events';
import { requireEnvironment, requireInstance } from './access';
import { sealsChanged } from '../nodes/seals';
import type { Ctx } from './context';
import { getStaged, saveStaged, scopeOf } from './staging';

/** Decrypted variables as of the last deploy. */
export function appliedVariables(
	db: DbOrTx,
	secrets: Secrets,
	environmentId: string,
	serviceId: string | null
): Record<string, string> {
	const rows = db
		.select({ key: variable.key, value: variable.value })
		.from(variable)
		.where(and(eq(variable.environmentId, environmentId), eq(variable.scope, scopeOf(serviceId))))
		.all();
	return Object.fromEntries(rows.map((row) => [row.key, secrets.decrypt(row.value)]));
}

/** Decrypted staged edits. */
export function stagedVariables(
	db: DbOrTx,
	secrets: Secrets,
	environmentId: string,
	serviceId: string | null
) {
	const staged = getStaged(db, environmentId, serviceId).variables ?? { set: {}, unset: [] };
	return {
		set: Object.fromEntries(
			Object.entries(staged.set).map(([key, value]) => [key, secrets.decrypt(value)])
		),
		unset: staged.unset
	};
}

/** What the next deploy will use. */
export function effectiveVariables(
	db: DbOrTx,
	secrets: Secrets,
	environmentId: string,
	serviceId: string | null
) {
	const result = { ...appliedVariables(db, secrets, environmentId, serviceId) };
	const staged = stagedVariables(db, secrets, environmentId, serviceId);
	for (const key of staged.unset) delete result[key];
	return Object.assign(result, staged.set);
}

/** Keys in a scope whose values are write-only. */
export function sealedKeys(db: DbOrTx, environmentId: string, serviceId: string | null) {
	return new Set(
		db
			.select({ key: sealedVariable.key })
			.from(sealedVariable)
			.where(
				and(
					eq(sealedVariable.environmentId, environmentId),
					eq(sealedVariable.scope, scopeOf(serviceId))
				)
			)
			.all()
			.map((row) => row.key)
	);
}

/** Drops seals for keys that no longer exist, deployed or staged. */
export function pruneSeals(
	db: DbOrTx,
	secrets: Secrets,
	environmentId: string,
	serviceId: string | null
) {
	const present = {
		...appliedVariables(db, secrets, environmentId, serviceId),
		...effectiveVariables(db, secrets, environmentId, serviceId)
	};
	for (const key of sealedKeys(db, environmentId, serviceId)) {
		if (key in present) continue;
		db.delete(sealedVariable)
			.where(
				and(
					eq(sealedVariable.environmentId, environmentId),
					eq(sealedVariable.scope, scopeOf(serviceId)),
					eq(sealedVariable.key, key)
				)
			)
			.run();
	}
}

function check(ctx: Ctx, environmentId: string, serviceId: string | null | undefined) {
	return serviceId
		? requireInstance(ctx, serviceId, environmentId).environment
		: requireEnvironment(ctx, environmentId);
}

export function list(
	ctx: Ctx,
	query: { environmentId: string; serviceId?: string | null }
): Variable[] {
	check(ctx, query.environmentId, query.serviceId);
	const serviceId = query.serviceId ?? null;
	const applied = appliedVariables(ctx.db, ctx.secrets, query.environmentId, serviceId);
	const staged = stagedVariables(ctx.db, ctx.secrets, query.environmentId, serviceId);

	const sealed = sealedKeys(ctx.db, query.environmentId, serviceId);
	const shown = (key: string, value: string) => (sealed.has(key) ? null : value);

	const variables: Variable[] = Object.entries(applied).map(([key, value]) => ({
		key,
		value: shown(key, staged.set[key] ?? value),
		sealed: sealed.has(key),
		staged: staged.unset.includes(key) ? 'removed' : key in staged.set ? 'modified' : null
	}));
	for (const [key, value] of Object.entries(staged.set)) {
		if (!(key in applied)) {
			variables.push({ key, value: shown(key, value), sealed: sealed.has(key), staged: 'added' });
		}
	}
	return variables.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Stages variable edits. Setting a key back to its deployed value (or unsetting
 * a key that was only staged) cancels the pending change instead of adding one.
 */
export function stage(
	ctx: Ctx,
	input: StageVariables & {
		set: Record<string, string>;
		unset: string[];
		seal?: string[];
		restore?: string[];
	}
) {
	const env = check(ctx, input.environmentId, input.serviceId);
	const serviceId = input.serviceId ?? null;
	const applied = appliedVariables(ctx.db, ctx.secrets, input.environmentId, serviceId);
	const payload = getStaged(ctx.db, input.environmentId, serviceId);
	const staged = payload.variables ?? { set: {}, unset: [] };
	const set = { ...staged.set };
	const unset = new Set(staged.unset);

	for (const [key, value] of Object.entries(input.set)) {
		unset.delete(key);
		if (applied[key] === value) delete set[key];
		else set[key] = ctx.secrets.encrypt(value);
	}
	for (const key of input.unset) {
		delete set[key];
		if (key in applied) unset.add(key);
	}
	for (const key of input.restore ?? []) unset.delete(key);

	saveStaged(ctx.db, input.environmentId, serviceId, {
		...payload,
		variables: { set, unset: [...unset] }
	});

	if (input.seal?.length) {
		const present = effectiveVariables(ctx.db, ctx.secrets, input.environmentId, serviceId);
		const missing = input.seal.filter((key) => !(key in present));
		if (missing.length)
			throw new AppError('validation_failed', `Cannot seal unknown variable ${missing[0]}`);
		for (const key of input.seal) {
			ctx.db
				.insert(sealedVariable)
				.values({ environmentId: input.environmentId, serviceId, scope: scopeOf(serviceId), key })
				.onConflictDoNothing()
				.run();
		}
		sealsChanged();
	}
	pruneSeals(ctx.db, ctx.secrets, input.environmentId, serviceId);

	publish({
		type: 'variables',
		projectId: env.projectId,
		environmentId: input.environmentId,
		serviceId: serviceId ?? undefined
	});
	publish({ type: 'changes', projectId: env.projectId, environmentId: input.environmentId });
	return list(ctx, { environmentId: input.environmentId, serviceId });
}
