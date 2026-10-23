import type { StageVariables, Variable } from '@tramline/contracts';
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import type { Secrets } from '../crypto';
import { variable } from '../db/schema';
import { publish } from '../events';
import { requireEnvironment, requireInstance } from './access';
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

	const variables: Variable[] = Object.entries(applied).map(([key, value]) => ({
		key,
		value: staged.set[key] ?? value,
		staged: staged.unset.includes(key) ? 'removed' : key in staged.set ? 'modified' : null
	}));
	for (const [key, value] of Object.entries(staged.set)) {
		if (!(key in applied)) variables.push({ key, value, staged: 'added' });
	}
	return variables.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Stages variable edits. Setting a key back to its deployed value (or unsetting
 * a key that was only staged) cancels the pending change instead of adding one.
 */
export function stage(
	ctx: Ctx,
	input: StageVariables & { set: Record<string, string>; unset: string[] }
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

	saveStaged(ctx.db, input.environmentId, serviceId, {
		...payload,
		variables: { set, unset: [...unset] }
	});

	publish({
		type: 'variables',
		projectId: env.projectId,
		environmentId: input.environmentId,
		serviceId: serviceId ?? undefined
	});
	publish({ type: 'changes', projectId: env.projectId, environmentId: input.environmentId });
	return list(ctx, { environmentId: input.environmentId, serviceId });
}
