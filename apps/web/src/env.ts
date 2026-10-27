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
	TRAMLINE_SIGNUP: {
		description:
			'Who can create an account: `invite` (default; an invite link from an organization, or anyone while the install has no admin yet) or `open` (anyone who can reach the sign-up page).',
		schema: (value) => {
			const policy = value || 'invite';
			if (policy !== 'open' && policy !== 'invite') {
				throw new Error('TRAMLINE_SIGNUP must be open or invite');
			}
			return policy as 'open' | 'invite';
		}
	},
	TRAMLINE_AUTH_RATE_LIMIT: {
		description:
			'Rate limit sign-in and sign-up attempts in production (default true). Only disable for automated tests.',
		schema: (value) => value !== 'false'
	},
	TRAMLINE_BACKUP_S3_ENDPOINT: {
		description:
			'S3-compatible endpoint for backups of this install’s own database, e.g. https://s3.eu-west-1.amazonaws.com. Control-plane backups are off unless the endpoint, bucket and keys are set.',
		schema: optional
	},
	TRAMLINE_BACKUP_S3_REGION: {
		description: 'Region of the backup bucket (default us-east-1).',
		schema: optional
	},
	TRAMLINE_BACKUP_S3_BUCKET: { description: 'Bucket for control-plane backups.', schema: optional },
	TRAMLINE_BACKUP_S3_PREFIX: {
		description: 'Folder inside the bucket (optional).',
		schema: optional
	},
	TRAMLINE_BACKUP_S3_ACCESS_KEY_ID: {
		description: 'Access key for the backup bucket.',
		schema: optional
	},
	TRAMLINE_BACKUP_S3_SECRET_ACCESS_KEY: {
		description: 'Secret key for the backup bucket.',
		schema: optional
	},
	TRAMLINE_BACKUP_S3_PATH_STYLE: {
		description: 'Path-style URLs, as MinIO and most self-hosted stores need (default true).',
		schema: optional
	},
	TRAMLINE_BACKUP_INTERVAL_MINUTES: {
		description: 'How often to snapshot this install’s database (default 60; 0 turns it off).',
		schema: (value) => {
			const minutes = Number(value ?? 60);
			if (!Number.isInteger(minutes) || minutes < 0)
				throw new Error('TRAMLINE_BACKUP_INTERVAL_MINUTES must be a whole number');
			return minutes;
		}
	},
	TRAMLINE_BACKUP_KEEP: {
		description: 'Control-plane snapshots kept in the bucket (default 72).',
		schema: (value) => {
			const keep = Number(value ?? 72);
			if (!Number.isInteger(keep) || keep < 1)
				throw new Error('TRAMLINE_BACKUP_KEEP must be at least 1');
			return keep;
		}
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
