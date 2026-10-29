import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		expect: { requireAssertions: true },
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts'],
			reporter: ['text-summary', 'html', 'json-summary'],
			// ratchet these up as coverage grows; never lower them
			thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 }
		}
	}
});
