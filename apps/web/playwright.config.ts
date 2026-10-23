import { defineConfig } from '@playwright/test';

/** Set TRAMLINE_E2E_DOCKER=1 to also run an agent and the tests that deploy real containers. */
const docker = process.env.TRAMLINE_E2E_DOCKER === '1';
export const INGRESS_PORT = 8088;

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.{ts,js}',
	globalTeardown: './e2e/teardown.ts',
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure' },
	webServer: [
		{
			// fresh database and data directory per run so tests never depend on leftover state
			command:
				'rm -rf data/e2e data/e2e.db* && pnpm build && pnpm preview --port 4173 --strictPort',
			port: 4173,
			reuseExistingServer: false,
			env: {
				TRAMLINE_DATABASE_PATH: 'data/e2e.db',
				TRAMLINE_DATA_DIR: 'data/e2e',
				TRAMLINE_SECRET_KEY: 'e2e-only-secret-key-not-for-production-use',
				TRAMLINE_URL: 'http://localhost:4173',
				TRAMLINE_INGRESS_PORT: String(INGRESS_PORT),
				TRAMLINE_AUTH_RATE_LIMIT: 'false',
				// builds into its own output directory, so a running `pnpm dev` is never disturbed
				TRAMLINE_E2E: '1'
			}
		},
		...(docker
			? [
					{
						command: 'pnpm --filter @tramline/agent start',
						url: 'http://127.0.0.1:7172',
						reuseExistingServer: false,
						env: {
							TRAMLINE_URL: 'http://localhost:4173',
							TRAMLINE_AGENT_TOKEN_FILE: `${import.meta.dirname}/data/e2e/local-agent.token`,
							TRAMLINE_AGENT_STATE_DIR: `${import.meta.dirname}/data/e2e/agent`,
							TRAMLINE_AGENT_HEALTH_PORT: '7172'
						}
					}
				]
			: [])
	]
});
