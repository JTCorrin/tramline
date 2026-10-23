import { defineEnvVars } from '@sveltejs/kit/env';

const optional = (value: string | undefined) => value || undefined;

export const variables = defineEnvVars({
	TRAMLINE_SECRET_KEY: {
		description:
			'Secret used to sign sessions and (later) encrypt secrets at rest. At least 32 characters. Generate with `openssl rand -base64 32`.',
		schema: (value) => {
			if (!value || value.length < 32) {
				throw new Error('TRAMLINE_SECRET_KEY must be set to at least 32 characters');
			}
			return value;
		}
	},
	TRAMLINE_DATABASE_PATH: {
		description: 'Path to the SQLite database file.',
		schema: (value) => value || 'data/tramline.db'
	},
	TRAMLINE_DATA_DIR: {
		description: 'Directory for deployment logs and the local agent token (default: data).',
		schema: (value) => value || 'data'
	},
	TRAMLINE_BASE_DOMAIN: {
		description:
			'Wildcard domain for generated service URLs, e.g. apps.example.com (needs a *.apps.example.com DNS record). Defaults to localhost, served over plain HTTP.',
		schema: (value) => (value || 'localhost').toLowerCase()
	},
	TRAMLINE_INGRESS_PORT: {
		description: 'Host port the ingress proxy listens on for HTTP (default 80).',
		schema: (value) => {
			const port = Number(value || 80);
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				throw new Error('TRAMLINE_INGRESS_PORT must be a port number');
			}
			return port;
		}
	},
	TRAMLINE_GIT_POLL_SECONDS: {
		description:
			'How often to check GitHub for new commits when webhooks can’t reach this install (default 60; 0 turns polling off). With webhooks it runs 5× less often as a safety net.',
		schema: (value) => {
			const seconds = Number(value ?? 60);
			if (!Number.isInteger(seconds) || seconds < 0)
				throw new Error('TRAMLINE_GIT_POLL_SECONDS must be a whole number');
			return seconds;
		}
	},
	TRAMLINE_URL: {
		description: 'Public URL of this Tramline install, e.g. https://tramline.example.com.',
		schema: optional
	},
	TRAMLINE_AUTH_RATE_LIMIT: {
		description:
			'Rate limit sign-in and sign-up attempts in production (default true). Only disable for automated tests.',
		schema: (value) => value !== 'false'
	},
	GITHUB_CLIENT_ID: {
		description: 'GitHub OAuth app client id. Enables "Continue with GitHub" when set.',
		schema: optional
	},
	GITHUB_CLIENT_SECRET: {
		description: 'GitHub OAuth app client secret.',
		schema: optional
	}
});
