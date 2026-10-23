import { describe, expect, it } from 'vitest';
import { timeAgo } from './format';

describe('timeAgo', () => {
	const now = Date.parse('2026-10-23T12:00:00Z');
	it.each([
		['2026-10-23T11:59:30Z', 'just now'],
		['2026-10-23T11:57:00Z', '3 minutes ago'],
		['2026-10-23T09:00:00Z', '3 hours ago'],
		['2026-10-22T12:00:00Z', 'yesterday'],
		['2025-10-23T12:00:00Z', 'last year']
	])('%s → %s', (iso, expected) => {
		expect(timeAgo(iso, now)).toBe(expected);
	});
});
