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
