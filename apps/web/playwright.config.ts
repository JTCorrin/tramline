import { defineConfig } from '@playwright/test';

/** Set TRAMLINE_E2E_DOCKER=1 to also run an agent and the tests that deploy real containers. */
const docker = process.env.TRAMLINE_E2E_DOCKER === '1';
export const INGRESS_PORT = 8088;

/** An S3-compatible bucket for the backup tests (Versity Gateway on a local directory). */
export const E2E_S3 = {
	port: 9900,
	container: 'tramline-e2e-s3',
	image:
		'versity/versitygw:v1.8.0@sha256:30292fc2eeacc67a36993b01f7a7a5e3361a19cced0e80c1d71cfa2a4b0a2499',
	bucket: 'tramline-e2e',
	accessKeyId: 'e2e-access-key',
	secretAccessKey: 'e2e-secret-key-not-for-production'
};

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.{ts,js}',
	globalTeardown: './e2e/teardown.ts',
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	// builds and image scans run alongside the UI tests and load the machine, so give those more room
	...(docker ? { timeout: 90_000, expect: { timeout: 15_000 } } : {}),
	use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure' },
	webServer: [
		{
			// fresh database and data directory per run so tests never depend on leftover state
			command:
				'rm -rf data/e2e data/e2e.db* data/e2e-agent/caddy && pnpm build && pnpm preview --port 4173 --strictPort',
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
							// outside data/e2e so the checksum-verified Railpack and Trivy downloads are reused
							TRAMLINE_AGENT_STATE_DIR: `${import.meta.dirname}/data/e2e-agent`,
							TRAMLINE_AGENT_HEALTH_PORT: '7172'
						}
					},
					{
						// answers 403 to anonymous requests, which Playwright counts as up
						command: [
							'docker run --rm',
							`--name ${E2E_S3.container}`,
							`-p ${E2E_S3.port}:7070`,
							'--entrypoint sh',
							E2E_S3.image,
							`-c 'mkdir -p /tmp/s3/${E2E_S3.bucket} && exec versitygw --access ${E2E_S3.accessKeyId} --secret ${E2E_S3.secretAccessKey} --port :7070 posix /tmp/s3'`
						].join(' '),
						url: `http://127.0.0.1:${E2E_S3.port}/`,
						reuseExistingServer: false
					}
				]
			: [])
	]
});
