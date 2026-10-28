import { z } from 'zod';

/**
 * Turns an adapter's credentials schema into form fields, so the "Connect
 * account" form needs no adapter-specific code. Only flat objects of
 * strings, numbers, booleans and enums are supported, which is all a
 * credentials form should need.
 */

export interface CredentialField {
	key: string;
	label: string;
	description: string | null;
	type: 'string' | 'number' | 'boolean' | 'enum';
	options: string[] | null;
	required: boolean;
	/** Stored encrypted and never sent back; leave it blank to keep the saved value. */
	secret: boolean;
	placeholder: string | null;
	default: string | number | boolean | null;
}

interface JsonProperty {
	type?: string;
	enum?: unknown[];
	title?: string;
	description?: string;
	secret?: boolean;
	placeholder?: string;
	default?: unknown;
}

const humanize = (key: string) =>
	key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

export function credentialFields(schema: z.ZodType): CredentialField[] {
	const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as {
		type?: string;
		properties?: Record<string, JsonProperty>;
		required?: string[];
	};
	if (json.type !== 'object') throw new Error('Adapter credentials must be an object schema');
	return Object.entries(json.properties ?? {}).map(([key, prop]) => {
		const type = prop.enum
			? 'enum'
			: prop.type === 'number' || prop.type === 'integer'
				? 'number'
				: prop.type === 'boolean'
					? 'boolean'
					: 'string';
		const fallback = prop.default;
		return {
			key,
			label: prop.title ?? humanize(key),
			description: prop.description ?? null,
			type,
			options: prop.enum ? prop.enum.map(String) : null,
			required: (json.required ?? []).includes(key) && fallback === undefined,
			secret: prop.secret === true,
			placeholder: prop.placeholder ?? null,
			default:
				typeof fallback === 'string' ||
				typeof fallback === 'number' ||
				typeof fallback === 'boolean'
					? fallback
					: null
		} satisfies CredentialField;
	});
}

/** Saved credentials without their secrets, safe to show. */
export function publicCredentials(schema: z.ZodType, creds: Record<string, unknown>) {
	const secret = new Set(
		credentialFields(schema)
			.filter((f) => f.secret)
			.map((f) => f.key)
	);
	return Object.fromEntries(Object.entries(creds).filter(([key]) => !secret.has(key)));
}

/**
 * Credentials to save: what was entered, keeping a saved secret that was
 * left blank, then checked against the adapter's schema.
 */
export function mergeCredentials<Creds>(
	schema: z.ZodType<Creds>,
	input: Record<string, unknown>,
	saved: Record<string, unknown> | null
): Creds {
	const merged: Record<string, unknown> = { ...input };
	for (const field of credentialFields(schema)) {
		const value = merged[field.key];
		if (field.secret && (value === undefined || value === '') && saved && field.key in saved) {
			merged[field.key] = saved[field.key];
		} else if (value === '' && !field.required) {
			delete merged[field.key];
		}
	}
	return schema.parse(merged);
}
