import { describe, expect, it } from 'vitest';
import { defaultOffer, formatMemory, tooSmall } from './offers';

describe('offers', () => {
	it('shows memory without rounding small sizes up', () => {
		expect(formatMemory(512)).toBe('512 MB');
		expect(formatMemory(1024)).toBe('1 GB');
		expect(formatMemory(3584)).toBe('3.5 GB');
	});

	it('defaults to the first size with enough memory', () => {
		const offers = [
			{ id: 'Standard_B1ls', memoryMb: 512 },
			{ id: 'Standard_B1s', memoryMb: 1024 }
		];
		expect(defaultOffer(offers)).toBe('Standard_B1s');
		expect(defaultOffer(offers.slice(0, 1))).toBe('Standard_B1ls');
		expect(defaultOffer([])).toBe('');
	});

	it('warns about sizes under 1 GB', () => {
		expect(tooSmall({ memoryMb: 512 })).toMatch(/512 MB is too little/);
		expect(tooSmall({ memoryMb: 1024 })).toBeNull();
		expect(tooSmall(undefined)).toBeNull();
	});
});
