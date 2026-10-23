import type { DesiredState } from '@tramline/contracts';

export const INGRESS_NAME = 'tramline-ingress';
export const INGRESS_IMAGE = 'caddy:2-alpine';
/** Where the generated config lives inside the ingress container. */
export const INGRESS_CONFIG_PATH = '/etc/tramline/caddy.json';

/** Caddy JSON config routing each public hostname to its live deployment. */
export function caddyConfig(ingress: DesiredState['ingress']) {
	const routes: object[] = ingress.routes.map((route) => ({
		match: [{ host: [route.host] }],
		handle: [
			{
				handler: 'reverse_proxy',
				upstreams: route.upstreams.map((dial) => ({ dial }))
			}
		],
		terminal: true
	}));
	routes.push({
		match: [],
		handle: [
			{
				handler: 'static_response',
				status_code: 404,
				body: 'No Tramline service is deployed at this address.\n'
			}
		],
		terminal: true
	});

	return {
		apps: {
			http: {
				servers: {
					tramline: {
						listen: ingress.tls ? [':443'] : [':80'],
						routes,
						...(ingress.tls ? {} : { automatic_https: { disable: true } })
					}
				}
			}
		}
	};
}
