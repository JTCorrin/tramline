import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.{ts,js}',
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure' },
	webServer: {
		// fresh database per run so tests never depend on leftover state
		command: 'rm -f data/e2e.db* && pnpm build && pnpm preview --port 4173 --strictPort',
		port: 4173,
		reuseExistingServer: false,
		env: {
			TRAMLINE_DATABASE_PATH: 'data/e2e.db',
			TRAMLINE_URL: 'http://localhost:4173',
			TRAMLINE_AUTH_RATE_LIMIT: 'false',
			TRAMLINE_SECRET_KEY: 'e2e-only-secret-key-not-for-production-use'
		}
	}
});
