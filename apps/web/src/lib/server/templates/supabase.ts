import type { TemplateInput } from '@tramline/contracts';
import kong from './supabase/kong.yml?raw';
import supabaseDb from './supabase/_supabase.sql?raw';
import jwtSql from './supabase/jwt.sql?raw';
import realtimeSql from './supabase/realtime.sql?raw';
import rolesSql from './supabase/roles.sql?raw';
import webhooksSql from './supabase/webhooks.sql?raw';

/**
 * Supabase, after its official self-hosting compose (docker/docker-compose.yml),
 * with the Kong gateway of the releases before Envoy. Left out: imgproxy, the
 * analytics stack (Logflare, Vector), Supavisor and Edge Functions.
 */

const DB = '${{ db.TRAMLINE_PRIVATE_DOMAIN }}';
const DB_PASSWORD = '${{ db.POSTGRES_PASSWORD }}';
const PUBLIC_URL = 'https://${{ kong.TRAMLINE_PUBLIC_DOMAIN }}';
const JWT_SECRET = '${{ auth.JWT_SECRET }}';
const ANON_KEY = '${{ auth.ANON_KEY }}';
const SERVICE_ROLE_KEY = '${{ auth.SERVICE_ROLE_KEY }}';
const JWT_EXPIRY = '3600';

/** Postgres' init scripts, where Supabase's compose mounts them. */
const INITDB = '/docker-entrypoint-initdb.d';

/**
 * pgsodium and Vault encrypt with a root key the image makes on first start in
 * /etc/postgresql-custom, which compose keeps on a second volume. Here it's
 * derived from a generated seed each start instead, so it survives the
 * container being recreated; then the image's own entrypoint takes over.
 */
const DB_START =
	'printf %s "$PGSODIUM_ROOT_KEY_SEED" | sha256sum | cut -c1-64 | tr -d "\\n" > /etc/postgresql-custom/pgsodium_root.key' +
	' && chown postgres:postgres /etc/postgresql-custom/pgsodium_root.key' +
	' && chmod 600 /etc/postgresql-custom/pgsodium_root.key' +
	' && exec docker-entrypoint.sh postgres -D /etc/postgresql';

export const supabase: TemplateInput = {
	id: 'supabase',
	version: 1,
	name: 'Supabase',
	tagline: 'Postgres with auth, a REST API, realtime, storage and Studio',
	description:
		'Self-hosted Supabase, after its official Docker setup: Supabase’s Postgres, Auth (GoTrue), PostgREST, Realtime, Storage (files kept on a volume), postgres-meta and Studio, behind a Kong gateway on a public domain. The anon and service_role keys and the JWT secret are generated for each environment. Studio stays private. Left out: image transformations (imgproxy), logs and analytics (Logflare, Vector), the Supavisor pooler and Edge Functions.',
	icon: 'supabase',
	tags: ['backend', 'postgres', 'auth', 'api', 'realtime', 'storage'],
	docsUrl: 'https://supabase.com/docs/guides/self-hosting/docker',
	questions: [
		{
			key: 'SITE_URL',
			label: 'Site URL',
			description:
				'Where the app that uses Supabase lives. Auth sends people back here after they sign in or confirm their email.',
			placeholder: 'https://app.example.com',
			default: 'http://localhost:3000'
		},
		{
			key: 'ADDITIONAL_REDIRECT_URLS',
			label: 'Other redirect URLs',
			description: 'More URLs Auth may redirect to, separated by commas. Optional.',
			placeholder: 'https://staging.example.com/**'
		},
		{
			key: 'MAILER_AUTOCONFIRM',
			label: 'Skip email confirmation',
			description:
				'true lets new users sign in without confirming their email, which is needed until SMTP is set up; false once it is.',
			default: 'true'
		},
		{
			key: 'SMTP_HOST',
			label: 'SMTP host',
			description: 'For Auth’s emails (confirmations, magic links, password resets). Optional.',
			placeholder: 'smtp.example.com'
		},
		{ key: 'SMTP_PORT', label: 'SMTP port', default: '587' },
		{ key: 'SMTP_USER', label: 'SMTP user' },
		{ key: 'SMTP_PASS', label: 'SMTP password', secret: true },
		{
			key: 'SMTP_ADMIN_EMAIL',
			label: 'Sender address',
			description: 'The address Auth’s emails come from.',
			placeholder: 'noreply@example.com'
		},
		{ key: 'SMTP_SENDER_NAME', label: 'Sender name', default: 'Supabase' }
	],
	services: [
		{
			key: 'kong',
			name: 'kong',
			icon: 'network',
			image: 'kong:2.8.1@sha256:1b53405d8680a09d6f44494b7990bf7da2ea43f84a258c59717d4539abf09f6d',
			config: {
				deploy: {
					restartPolicy: 'always',
					memoryRequestMb: 192,
					cpuRequest: 0.1,
					files: [{ path: '/home/kong/kong.yml', content: kong }]
				},
				networking: { port: 8000, publicDomain: true }
			},
			variables: {
				KONG_DATABASE: 'off',
				KONG_DECLARATIVE_CONFIG: '/home/kong/kong.yml',
				// https://github.com/supabase/cli/issues/14
				KONG_DNS_ORDER: 'LAST,A,CNAME',
				// upstreams move when they redeploy, and may not exist yet when Kong starts
				KONG_DNS_VALID_TTL: '5',
				KONG_DNS_NOT_FOUND_TTL: '1',
				KONG_PLUGINS: 'request-transformer,cors,key-auth,acl,basic-auth,request-termination',
				KONG_NGINX_PROXY_PROXY_BUFFER_SIZE: '160k',
				KONG_NGINX_PROXY_PROXY_BUFFERS: '64 160k',
				KONG_NGINX_WORKER_PROCESSES: '2',
				KONG_PROXY_ACCESS_LOG: '/dev/stdout',
				KONG_PROXY_ERROR_LOG: '/dev/stderr',
				// only Tramline's ingress (and the environment's services) reach Kong:
				// keep its X-Forwarded-* (https, the client's address) for the services
				KONG_TRUSTED_IPS: '0.0.0.0/0,::/0',
				SUPABASE_ANON_KEY: ANON_KEY,
				SUPABASE_SERVICE_KEY: SERVICE_ROLE_KEY,
				AUTH_HOST: '${{ auth.TRAMLINE_PRIVATE_DOMAIN }}',
				REST_HOST: '${{ rest.TRAMLINE_PRIVATE_DOMAIN }}',
				REALTIME_HOST: '${{ realtime.TRAMLINE_PRIVATE_DOMAIN }}',
				STORAGE_HOST: '${{ storage.TRAMLINE_PRIVATE_DOMAIN }}'
			},
			position: { x: 0, y: 210 }
		},
		{
			key: 'auth',
			name: 'auth',
			icon: 'key-round',
			image:
				'supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b',
			config: {
				deploy: {
					dependsOn: ['db'],
					restartPolicy: 'always',
					memoryRequestMb: 64,
					cpuRequest: 0.05,
					healthcheckPath: '/health'
				},
				networking: { port: 9999 }
			},
			variables: {
				// the stack's signing secret and API keys: everything else refers to these
				JWT_SECRET: { generate: 'secret', length: 64 },
				ANON_KEY: {
					generate: 'jwt',
					secret: 'JWT_SECRET',
					claims: { role: 'anon', iss: 'supabase' },
					sealed: false
				},
				SERVICE_ROLE_KEY: {
					generate: 'jwt',
					secret: 'JWT_SECRET',
					claims: { role: 'service_role', iss: 'supabase' }
				},
				GOTRUE_API_HOST: '0.0.0.0',
				GOTRUE_API_PORT: '9999',
				API_EXTERNAL_URL: `${PUBLIC_URL}/auth/v1`,
				GOTRUE_DB_DRIVER: 'postgres',
				GOTRUE_DB_DATABASE_URL: `postgres://supabase_auth_admin:${DB_PASSWORD}@${DB}:5432/postgres`,
				GOTRUE_SITE_URL: '${{ answers.SITE_URL }}',
				GOTRUE_URI_ALLOW_LIST: '${{ answers.ADDITIONAL_REDIRECT_URLS }}',
				GOTRUE_DISABLE_SIGNUP: 'false',
				GOTRUE_JWT_ADMIN_ROLES: 'service_role',
				GOTRUE_JWT_AUD: 'authenticated',
				GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
				GOTRUE_JWT_EXP: JWT_EXPIRY,
				GOTRUE_JWT_SECRET: '${{ JWT_SECRET }}',
				GOTRUE_JWT_ISSUER: '${{ API_EXTERNAL_URL }}',
				GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
				GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: 'false',
				GOTRUE_MAILER_AUTOCONFIRM: '${{ answers.MAILER_AUTOCONFIRM }}',
				GOTRUE_SMTP_ADMIN_EMAIL: '${{ answers.SMTP_ADMIN_EMAIL }}',
				GOTRUE_SMTP_HOST: '${{ answers.SMTP_HOST }}',
				GOTRUE_SMTP_PORT: '${{ answers.SMTP_PORT }}',
				GOTRUE_SMTP_USER: '${{ answers.SMTP_USER }}',
				GOTRUE_SMTP_PASS: '${{ answers.SMTP_PASS }}',
				GOTRUE_SMTP_SENDER_NAME: '${{ answers.SMTP_SENDER_NAME }}',
				GOTRUE_MAILER_URLPATHS_INVITE: '/auth/v1/verify',
				GOTRUE_MAILER_URLPATHS_CONFIRMATION: '/auth/v1/verify',
				GOTRUE_MAILER_URLPATHS_RECOVERY: '/auth/v1/verify',
				GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: '/auth/v1/verify',
				// no SMS provider is set up
				GOTRUE_EXTERNAL_PHONE_ENABLED: 'false',
				GOTRUE_SMS_AUTOCONFIRM: 'false'
			},
			position: { x: 320, y: 0 }
		},
		{
			key: 'rest',
			name: 'rest',
			icon: 'braces',
			image:
				'postgrest/postgrest:v14.18@sha256:c7cd7e265a85b05248abf53f4473fcec7e327c282d0bd0cf60f1551996d09fcf',
			config: {
				deploy: {
					dependsOn: ['db'],
					restartPolicy: 'always',
					memoryRequestMb: 64,
					cpuRequest: 0.1
				},
				networking: { port: 3000 }
			},
			variables: {
				PGRST_DB_URI: `postgres://authenticator:${DB_PASSWORD}@${DB}:5432/postgres`,
				PGRST_DB_SCHEMAS: 'public,graphql_public',
				PGRST_DB_MAX_ROWS: '1000',
				PGRST_DB_EXTRA_SEARCH_PATH: 'public',
				PGRST_DB_ANON_ROLE: 'anon',
				PGRST_ADMIN_SERVER_PORT: '3001',
				PGRST_ADMIN_SERVER_HOST: 'localhost',
				PGRST_JWT_SECRET: JWT_SECRET,
				PGRST_DB_USE_LEGACY_GUCS: 'false',
				PGRST_APP_SETTINGS_JWT_EXP: JWT_EXPIRY
			},
			position: { x: 320, y: 140 }
		},
		{
			key: 'realtime',
			name: 'realtime',
			icon: 'radio',
			image:
				'supabase/realtime:v2.148.3@sha256:25cf375b9b7cb71d90cdf6e04a1a30996e39a8df866ebd0525bba1d959edc8d6',
			config: {
				deploy: {
					dependsOn: ['db'],
					restartPolicy: 'always',
					memoryRequestMb: 256,
					cpuRequest: 0.1,
					healthcheckPath: '/healthcheck'
				},
				networking: { port: 4000 }
			},
			variables: {
				// PORT is Tramline's own: the networking port, 4000
				DB_HOST: DB,
				DB_PORT: '5432',
				DB_USER: 'supabase_admin',
				DB_PASSWORD: DB_PASSWORD,
				DB_NAME: 'postgres',
				DB_AFTER_CONNECT_QUERY: 'SET search_path TO _realtime',
				// AES-128: 16 characters
				DB_ENC_KEY: { generate: 'secret', length: 16 },
				API_JWT_SECRET: JWT_SECRET,
				SECRET_KEY_BASE: { generate: 'secret', length: 64 },
				METRICS_JWT_SECRET: JWT_SECRET,
				ERL_AFLAGS: '-proto_dist inet_tcp',
				DNS_NODES: "''",
				RLIMIT_NOFILE: '10000',
				APP_NAME: 'realtime',
				SEED_SELF_HOST: 'true',
				// Realtime's tenant is the first label of the Host header, which is
				// this service's private domain (Kong proxies to it), so its name
				SELF_HOST_TENANT_NAME: '${{ TRAMLINE_SERVICE_NAME }}',
				RUN_JANITOR: 'true',
				DISABLE_HEALTHCHECK_LOGGING: 'true'
			},
			position: { x: 320, y: 280 }
		},
		{
			key: 'storage',
			name: 'storage',
			icon: 'hard-drive',
			image:
				'supabase/storage-api:v1.89.12@sha256:8526956cb462e9f7d392e9848ec77133b2769982ed614e9753cc687e8e4339a6',
			config: {
				deploy: {
					dependsOn: ['db', 'rest'],
					restartPolicy: 'always',
					memoryRequestMb: 128,
					cpuRequest: 0.1,
					healthcheckPath: '/status'
				},
				networking: { port: 5000 },
				volume: { mountPath: '/var/lib/storage' }
			},
			variables: {
				ANON_KEY: ANON_KEY,
				SERVICE_KEY: SERVICE_ROLE_KEY,
				POSTGREST_URL: 'http://${{ rest.TRAMLINE_PRIVATE_DOMAIN }}:3000',
				AUTH_JWT_SECRET: JWT_SECRET,
				DATABASE_URL: `postgres://supabase_storage_admin:${DB_PASSWORD}@${DB}:5432/postgres`,
				STORAGE_PUBLIC_URL: PUBLIC_URL,
				REQUEST_ALLOW_X_FORWARDED_PATH: 'true',
				FILE_SIZE_LIMIT: '52428800',
				STORAGE_BACKEND: 'file',
				// the directory name under FILE_STORAGE_BACKEND_PATH with the file backend
				GLOBAL_S3_BUCKET: 'stub',
				FILE_STORAGE_BACKEND_PATH: '/var/lib/storage',
				TENANT_ID: 'stub',
				REGION: 'stub',
				// imgproxy isn't in the stack
				ENABLE_IMAGE_TRANSFORMATION: 'false',
				// credentials for Storage's S3-compatible endpoint, /storage/v1/s3
				S3_PROTOCOL_ACCESS_KEY_ID: { generate: 'secret', length: 32 },
				S3_PROTOCOL_ACCESS_KEY_SECRET: { generate: 'secret', length: 64 }
			},
			position: { x: 320, y: 420 }
		},
		{
			key: 'db',
			name: 'db',
			database: 'postgres',
			image:
				'supabase/postgres:17.6.1.136@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00',
			config: {
				deploy: {
					restartPolicy: 'always',
					memoryRequestMb: 512,
					cpuRequest: 0.5,
					startCommand: DB_START,
					files: [
						{ path: `${INITDB}/migrations/97-_supabase.sql`, content: supabaseDb },
						{ path: `${INITDB}/migrations/99-realtime.sql`, content: realtimeSql },
						{ path: `${INITDB}/init-scripts/98-webhooks.sql`, content: webhooksSql },
						{ path: `${INITDB}/init-scripts/99-roles.sql`, content: rolesSql },
						{ path: `${INITDB}/init-scripts/99-jwt.sql`, content: jwtSql }
					]
				},
				networking: { port: 5432, tcpProxy: false },
				volume: { mountPath: '/var/lib/postgresql/data' }
			},
			variables: {
				// the image's superuser: the init scripts, backups and restores run as it,
				// over the local socket, where it's trusted
				POSTGRES_USER: 'supabase_admin',
				// supabase_admin's and postgres' password, and (roles.sql) that of
				// authenticator, supabase_auth_admin, supabase_storage_admin and the rest
				POSTGRES_PASSWORD: { generate: 'secret', length: 40 },
				PGPASSWORD: '${{ POSTGRES_PASSWORD }}',
				POSTGRES_DB: 'postgres',
				PGDATABASE: '${{ POSTGRES_DB }}',
				POSTGRES_HOST: '/var/run/postgresql',
				POSTGRES_PORT: '5432',
				PGPORT: '${{ POSTGRES_PORT }}',
				// read by jwt.sql
				JWT_EXP: JWT_EXPIRY,
				PGSODIUM_ROOT_KEY_SEED: { generate: 'secret', length: 64 }
			},
			position: { x: 640, y: 210 }
		},
		{
			key: 'meta',
			name: 'meta',
			icon: 'table',
			image:
				'supabase/postgres-meta:v0.100.0@sha256:145325b7e39f8ef4931d6e8cfd3f6f4d655de09d72a2ccc96d9513542c2202bd',
			config: {
				deploy: {
					dependsOn: ['db'],
					restartPolicy: 'always',
					memoryRequestMb: 96,
					cpuRequest: 0.05,
					healthcheckPath: '/health'
				},
				networking: { port: 8080 }
			},
			variables: {
				PG_META_PORT: '8080',
				PG_META_DB_HOST: DB,
				PG_META_DB_PORT: '5432',
				PG_META_DB_NAME: 'postgres',
				PG_META_DB_USER: 'postgres',
				PG_META_DB_PASSWORD: DB_PASSWORD,
				CRYPTO_KEY: { generate: 'secret', length: 32 }
			},
			position: { x: 960, y: 140 }
		},
		{
			key: 'studio',
			name: 'studio',
			icon: 'layout-dashboard',
			image:
				'supabase/studio:2026.11.02-sha-a05e7ec@sha256:727a7f37b15f4c76c44e0d765e6be231d8d71c67f2933b2df8c6cbcc9b04c5d0',
			config: {
				deploy: {
					dependsOn: ['meta'],
					restartPolicy: 'always',
					memoryRequestMb: 256,
					cpuRequest: 0.1,
					healthcheckPath: '/api/platform/profile'
				},
				// private: Studio has no login of its own
				networking: { port: 3000, publicDomain: false },
				// saved SQL snippets
				volume: { mountPath: '/app/snippets' }
			},
			variables: {
				HOSTNAME: '0.0.0.0',
				STUDIO_PG_META_URL: 'http://${{ meta.TRAMLINE_PRIVATE_DOMAIN }}:8080',
				POSTGRES_HOST: DB,
				POSTGRES_PORT: '5432',
				POSTGRES_DB: 'postgres',
				POSTGRES_PASSWORD: DB_PASSWORD,
				POSTGRES_USER_READ_WRITE: 'postgres',
				PG_META_CRYPTO_KEY: '${{ meta.CRYPTO_KEY }}',
				PGRST_DB_SCHEMAS: 'public,graphql_public',
				PGRST_DB_MAX_ROWS: '1000',
				PGRST_DB_EXTRA_SEARCH_PATH: 'public',
				DEFAULT_ORGANIZATION_NAME: 'Default Organization',
				DEFAULT_PROJECT_NAME: 'Default Project',
				SUPABASE_URL: 'http://${{ kong.TRAMLINE_PRIVATE_DOMAIN }}:8000',
				SUPABASE_PUBLIC_URL: PUBLIC_URL,
				SUPABASE_ANON_KEY: ANON_KEY,
				SUPABASE_SERVICE_KEY: SERVICE_ROLE_KEY,
				AUTH_JWT_SECRET: JWT_SECRET,
				// logs need the analytics stack, which isn't here
				ENABLED_FEATURES_LOGS_ALL: 'false',
				SNIPPETS_MANAGEMENT_FOLDER: '/app/snippets'
			},
			position: { x: 960, y: 280 }
		}
	],
	notes: [
		'The API is on the kong service’s public domain: use https://<that domain> as your Supabase URL, with the anon key (ANON_KEY on the auth service). SERVICE_ROLE_KEY there bypasses row level security: keep it on servers only.',
		'Studio is private: it has no login, and anyone who reaches it can do anything to the database. Reach it from the environment’s private network, or give it a public domain only briefly.',
		'Until SMTP is set up, sign-ups are confirmed without an email (MAILER_AUTOCONFIRM). Set the GOTRUE_SMTP_* variables on auth and GOTRUE_MAILER_AUTOCONFIRM to false to send confirmations.',
		'Files are stored on the storage service’s volume. Image transformations, logs and analytics, the Supavisor pooler and Edge Functions aren’t included.',
		'The database isn’t reachable from outside Tramline. Turn on the TCP proxy on db for TLS connections as postgres, with POSTGRES_PASSWORD from db.',
		'The services start in any order: until the database is ready the others fail and restart, so give the stack a minute or two after the first deploy.'
	]
};
