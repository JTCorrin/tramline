import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.{ts,js}',
	use: { baseURL: 'http://localhost:4173' },
	webServer: {
		// fresh database per run so tests never depend on leftover state
		command: 'rm -f data/e2e.db* && pnpm build && pnpm preview --port 4173 --strictPort',
		port: 4173,
		reuseExistingServer: false,
		env: {
			TRAMLINE_DATABASE_PATH: 'data/e2e.db',
			TRAMLINE_URL: 'http://localhost:4173',
			TRAMLINE_SECRET_KEY: 'e2e-only-secret-key-not-for-production-use'
		}
	}
});
