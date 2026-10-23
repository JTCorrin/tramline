import { ApiError } from '#lib/api.js';
import { toast } from 'svelte-sonner';

/** Shows a toast for a failed request and returns its message. */
export function reportError(error: unknown, fallback = 'Something went wrong') {
	const message =
		error instanceof ApiError || error instanceof Error ? error.message || fallback : fallback;
	toast.error(message);
	return message;
}

/** Turns an organization name into a URL-safe slug. */
export function slugify(value: string) {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
}
