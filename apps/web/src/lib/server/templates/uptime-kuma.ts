import type { TemplateInput } from '@tramline/contracts';

/** Uptime Kuma: one service, its data (SQLite) on a volume. */
export const uptimeKuma: TemplateInput = {
	id: 'uptime-kuma',
	version: 1,
	name: 'Uptime Kuma',
	tagline: 'Uptime monitoring with a status page',
	description:
		'Uptime Kuma checks your sites and services (HTTP, TCP, DNS, ping and more), alerts you when they go down, and serves a status page. It keeps its data on a volume. Open the domain once it has deployed to create the admin account.',
	icon: 'activity',
	tags: ['monitoring'],
	docsUrl: 'https://github.com/louislam/uptime-kuma/wiki',
	services: [
		{
			key: 'uptime-kuma',
			name: 'uptime-kuma',
			icon: 'activity',
			image:
				'louislam/uptime-kuma:2.5.11@sha256:7554dba313c84e44fee921ef3b5626ba1c711e412e82815e8c957517026112a9',
			config: {
				deploy: { restartPolicy: 'always', memoryRequestMb: 192, cpuRequest: 0.1 },
				networking: { port: 3001, publicDomain: true },
				volume: { mountPath: '/app/data' }
			}
		}
	],
	notes: [
		'Open Uptime Kuma on its public domain once it has deployed and create the admin account straight away: until then, anyone who finds the domain can.'
	]
};
