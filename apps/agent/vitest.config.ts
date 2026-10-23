import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		expect: { requireAssertions: true },
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			// docker.ts and main.ts talk to a real daemon; covered by the e2e suite
			exclude: ['src/**/*.test.ts', 'src/testing.ts', 'src/docker.ts', 'src/main.ts'],
			reporter: ['text-summary', 'html', 'json-summary'],
			// ratchet these up as coverage grows; never lower them
			thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 }
		}
	}
});
