import type { DesiredState } from '@tramline/contracts';

/** One ingress per node, so several agents can share a Docker host (e.g. dev and e2e). */
export const ingressName = (nodeId: string) => `tramline-ingress-${nodeId}`;
export const INGRESS_IMAGE = 'caddy:2-alpine';
/** Where the generated config lives inside the ingress container. */
export const INGRESS_CONFIG_PATH = '/etc/tramline/caddy.json';

/** Caddy JSON config routing each public hostname to its live deployment. */
export function caddyConfig(ingress: DesiredState['ingress']) {
	const routes: object[] = ingress.routes.map((route) => ({
		match: [{ host: [route.host] }],
		handle: [
			// browsers must only ever reach HTTPS services over HTTPS again
			...(ingress.tls
				? [
						{
							handler: 'headers',
							response: {
								set: {
									// a user's own domain may have other subdomains that aren't on HTTPS
									'Strict-Transport-Security': [
										route.custom ? 'max-age=31536000' : 'max-age=31536000; includeSubDomains'
									]
								}
							}
						}
					]
				: []),
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
