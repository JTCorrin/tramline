import { defineEnvVars } from '@sveltejs/kit/env';
import { CIDR } from '@tramline/contracts';

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
	TRAMLINE_AGENT_URL: {
		description:
			'Where nodes on other machines reach this install, when that isn’t TRAMLINE_URL: e.g. an address that only exposes the agent API. A tunnel set up in Settings takes precedence.',
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
	TRAMLINE_ALERT_WEBHOOK_URL: {
		description:
			'Where to post alerts when they open and resolve, e.g. a Slack or Discord incoming webhook. The JSON body has `text` (Slack) and `content` (Discord), plus the alert itself.',
		schema: (value) => {
			if (!value) return undefined;
			if (!/^https?:\/\//.test(value)) {
				throw new Error('TRAMLINE_ALERT_WEBHOOK_URL must be an http(s) URL');
			}
			return value;
		}
	},
	TRAMLINE_ACCESS_LOG_DAYS: {
		description:
			'How many days of access logs (requests to public domains and connections to TCP proxies) to keep (default 14; 0 keeps none).',
		schema: (value) => {
			const days = Number(value ?? 14);
			if (!Number.isInteger(days) || days < 0)
				throw new Error('TRAMLINE_ACCESS_LOG_DAYS must be a whole number');
			return days;
		}
	},
	TRAMLINE_ACCESS_LOG_MAX_ROWS: {
		description:
			'The most access log entries kept across the install; the oldest go first (default 2000000, roughly 1 GB).',
		schema: (value) => {
			const rows = Number(value ?? 2_000_000);
			if (!Number.isInteger(rows) || rows < 1000)
				throw new Error('TRAMLINE_ACCESS_LOG_MAX_ROWS must be a whole number of at least 1000');
			return rows;
		}
	},
	TRAMLINE_ANONYMIZE_IPS: {
		description:
			'Store visitors’ addresses without their last part (the last number of an IPv4 address, all but the first 48 bits of an IPv6 one). Their network is looked up first. Off unless set to true.',
		schema: (value) => value === 'true' || value === '1'
	},
	TRAMLINE_TRUSTED_PROXIES: {
		description:
			'Comma-separated addresses or CIDRs of proxies in front of the ingress (e.g. a load balancer), whose X-Forwarded-For header names the visitor in access logs. The Cloudflare tunnel needs nothing here.',
		schema: (value) => {
			const list = (value ?? '')
				.split(',')
				.map((entry) => entry.trim())
				.filter(Boolean);
			for (const entry of list) {
				if (!CIDR.safeParse(entry).success)
					throw new Error(`TRAMLINE_TRUSTED_PROXIES: ${entry} is not an address or CIDR`);
			}
			return list;
		}
	},
	TRAMLINE_AGENT_UPDATE_HOURS: {
		description:
			'How often to check each node for a newer agent image and update it (default 6). Nodes update one at a time, never while a build or backup runs on them; an agent only restarts when its image changed. 0 turns automatic updates off.',
		schema: (value) => {
			const hours = Number(value ?? 6);
			if (!Number.isFinite(hours) || hours < 0)
				throw new Error('TRAMLINE_AGENT_UPDATE_HOURS must be a number of hours, or 0');
			return hours;
		}
	},
	TRAMLINE_ASN_DATA_URL: {
		description:
			'Where to download the IP-to-network data that names who each visitor’s address belongs to (default https://iptoasn.com/data/ip2asn-combined.tsv.gz, public domain; refreshed weekly). Addresses are looked up locally and never sent anywhere. `off` turns network names off.',
		schema: (value) => {
			if (value === 'off') return null;
			const url = value || 'https://iptoasn.com/data/ip2asn-combined.tsv.gz';
			if (!/^(https?|file):\/\//.test(url))
				throw new Error('TRAMLINE_ASN_DATA_URL must be an http(s) or file URL, or off');
			return url;
		}
	},
	TRAMLINE_FAKE_ADAPTER: {
		description:
			'Offer the in-memory fake compute adapter (tests only; its machines exist nowhere). Off unless set to 1.',
		schema: (value) => value === '1'
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
