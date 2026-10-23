import { z } from 'zod';

export const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const Variable = z.object({
	key: z.string(),
	/** null for sealed variables: their values are write-only. */
	value: z.string().nullable(),
	/** Sealed values are never returned by the API again; they can only be replaced. */
	sealed: z.boolean(),
	/** How this variable differs from the last deploy, if at all. */
	staged: z.enum(['added', 'modified', 'removed']).nullable()
});

export type Variable = z.infer<typeof Variable>;

export const VariableKey = z
	.string()
	.trim()
	.regex(VARIABLE_KEY, 'Keys use letters, numbers and underscores, and cannot start with a number')
	.max(128);

export const StageVariables = z.object({
	environmentId: z.string(),
	/** Omit (or null) for the environment's shared variables. */
	serviceId: z.string().nullable().optional(),
	set: z.record(VariableKey, z.string().max(32_768)).default({}),
	unset: z.array(VariableKey).default([]),
	/** Keys to seal. Takes effect immediately and cannot be undone. */
	seal: z.array(VariableKey).default([]),
	/** Keys whose staged removal should be cancelled. */
	restore: z.array(VariableKey).default([])
});

export type StageVariables = z.input<typeof StageVariables>;

export type VariableQuery = { environmentId: string; serviceId?: string };

/** A `${{ ... }}` reference inside a variable value. */
export interface VariableReference {
	/** `shared`, another service's name, or null for the same service. */
	namespace: string | null;
	key: string;
}

const REFERENCE = /\$\{\{\s*(?:([A-Za-z0-9_-]+)\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function parseReferences(value: string): VariableReference[] {
	return [...value.matchAll(REFERENCE)].map((match) => ({
		namespace: match[1] ?? null,
		key: match[2]!
	}));
}

/** Replaces every reference using `lookup`; unknown references become empty strings. */
export function replaceReferences(
	value: string,
	lookup: (reference: VariableReference) => string | undefined
) {
	return value.replace(
		REFERENCE,
		(_, namespace: string | undefined, key: string) =>
			lookup({ namespace: namespace ?? null, key }) ?? ''
	);
}
