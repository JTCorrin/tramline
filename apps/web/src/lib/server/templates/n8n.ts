import type { TemplateInput } from '@tramline/contracts';

/** n8n with its own Postgres: workflows and credentials kept in the database, encrypted with a generated key. */
export const n8n: TemplateInput = {
	id: 'n8n',
	version: 1,
	name: 'n8n',
	tagline: 'Workflow automation with its own Postgres',
	description:
		'n8n, the workflow automation tool, on a public domain, keeping its workflows, executions and credentials in a Postgres database next to it. Credentials are encrypted with a key Tramline generates. Open the domain once it has deployed to create the owner account.',
	icon: 'workflow',
	tags: ['automation', 'postgres'],
	docsUrl: 'https://docs.n8n.io/hosting/',
	questions: [
		{
			key: 'TIMEZONE',
			label: 'Time zone',
			description: 'For schedules, e.g. Europe/London.',
			placeholder: 'UTC',
			default: 'UTC'
		}
	],
	services: [
		{
			key: 'n8n',
			name: 'n8n',
			icon: 'workflow',
			image:
				'n8nio/n8n:2.47.7@sha256:b4b90747b81fcda7e76550c0d3aa7f0f64917a1e9573cff40d6834eaf2e0f8ea',
			config: {
				deploy: {
					dependsOn: ['postgres'],
					restartPolicy: 'always',
					memoryRequestMb: 384,
					cpuRequest: 0.25
				},
				networking: { port: 5678, publicDomain: true },
				volume: { mountPath: '/home/node/.n8n' }
			},
			variables: {
				N8N_ENCRYPTION_KEY: { generate: 'secret', length: 48 },
				N8N_PORT: '5678',
				N8N_PROTOCOL: 'https',
				N8N_HOST: '${{ TRAMLINE_PUBLIC_DOMAIN }}',
				WEBHOOK_URL: 'https://${{ TRAMLINE_PUBLIC_DOMAIN }}/',
				N8N_PROXY_HOPS: '1',
				N8N_RUNNERS_ENABLED: 'true',
				GENERIC_TIMEZONE: '${{ answers.TIMEZONE }}',
				TZ: '${{ answers.TIMEZONE }}',
				DB_TYPE: 'postgresdb',
				DB_POSTGRESDB_HOST: '${{ postgres.TRAMLINE_PRIVATE_DOMAIN }}',
				DB_POSTGRESDB_PORT: '5432',
				DB_POSTGRESDB_DATABASE: '${{ postgres.POSTGRES_DB }}',
				DB_POSTGRESDB_USER: '${{ postgres.POSTGRES_USER }}',
				DB_POSTGRESDB_PASSWORD: '${{ postgres.POSTGRES_PASSWORD }}'
			},
			position: { x: 0, y: 0 }
		},
		{
			key: 'postgres',
			name: 'postgres',
			database: 'postgres',
			image:
				'postgres:17.12@sha256:0d938e975177bef9f1f61f3f9dbcf2e0aa0a139568f66d3415ed8892eb97f6ac',
			config: {
				deploy: { restartPolicy: 'always', memoryRequestMb: 256, cpuRequest: 0.25 },
				networking: { port: 5432 },
				volume: { mountPath: '/var/lib/postgresql/data' }
			},
			variables: {
				POSTGRES_USER: 'n8n',
				POSTGRES_PASSWORD: { generate: 'secret', length: 32 },
				POSTGRES_DB: 'n8n',
				PGUSER: '${{ POSTGRES_USER }}',
				PGPASSWORD: '${{ POSTGRES_PASSWORD }}',
				PGDATABASE: '${{ POSTGRES_DB }}'
			},
			position: { x: 320, y: 0 }
		}
	],
	notes: [
		'Open n8n on its public domain once it has deployed and create the owner account straight away: until then, anyone who finds the domain can.',
		'Its credentials are encrypted with N8N_ENCRYPTION_KEY on the n8n service. Keep it: without it, saved credentials can’t be read after a restore.'
	]
};
