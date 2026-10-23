import { ApiError } from '@tramline/client';
import { toast } from 'svelte-sonner';
import { describe, expect, it, vi } from 'vitest';
import { reportError, slugify } from './forms';

describe('slugify', () => {
	it.each([
		['Acme Inc', 'acme-inc'],
		['  --Hello,  World!-- ', 'hello-world'],
		['x'.repeat(60), 'x'.repeat(48)]
	])('%s → %s', (input, expected) => expect(slugify(input)).toBe(expected));
});

describe('reportError', () => {
	it('toasts API and plain errors, with a fallback for anything else', () => {
		const spy = vi.spyOn(toast, 'error');
		expect(reportError(new ApiError(409, { code: 'conflict', message: 'Taken' }))).toBe('Taken');
		expect(reportError(new Error(''))).toBe('Something went wrong');
		expect(reportError('weird', 'Could not save')).toBe('Could not save');
		expect(spy).toHaveBeenCalledTimes(3);
	});
});
