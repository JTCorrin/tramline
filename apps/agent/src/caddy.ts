import type { DesiredState } from '@tramline/contracts';
import { TUNNEL_LOGGER } from './access';

/** One ingress per node, so several agents can share a Docker host (e.g. dev and e2e). */
export const ingressName = (nodeId: string) => `tramline-ingress-${nodeId}`;
export const INGRESS_IMAGE = 'caddy:2-alpine';
/** Where the agent puts the routes inside the ingress container (the image has /etc/caddy). */
export const INGRESS_CONFIG_PATH = '/etc/caddy/tramline.json';

type Route = DesiredState['ingress']['routes'][number];

/** Routes for the hostnames, then a 404 for anything else. `https`: visitors arrive over HTTPS. */
function routesFor(list: Route[], https: boolean, { behindTls = false } = {}) {
	const routes: object[] = list.map((route) => ({
		match: [{ host: [route.host] }],
		handle: [
			// browsers must only ever reach HTTPS services over HTTPS again
			...(https
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
				upstreams: route.upstreams.map((dial) => ({ dial })),
				// the request reached Cloudflare over HTTPS; apps building URLs need to know
				...(behindTls ? { headers: { request: { set: { 'X-Forwarded-Proto': ['https'] } } } } : {})
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
	return routes;
}

/**
 * Caddy JSON config routing each public hostname to its live deployment.
 * Every request is logged, as JSON on stdout, where the agent reads it (see
 * access.ts); Caddy's own messages stay on stderr. The tunnel server logs
 * under its own name, so the agent knows which requests the connector made.
 */
export function caddyConfig(ingress: DesiredState['ingress']) {
	const tunnel = ingress.tunnel ?? null;
	return {
		logging: {
			logs: {
				default: { exclude: ['http.log.access'] },
				access: {
					writer: { output: 'stdout' },
					encoder: { format: 'json' },
					include: ['http.log.access']
				}
			}
		},
		apps: {
			http: {
				servers: {
					tramline: {
						listen: ingress.tls ? [':443'] : [':80'],
						routes: routesFor(ingress.routes, ingress.tls),
						logs: { default_logger_name: 'ingress' },
						...(ingress.tls ? {} : { automatic_https: { disable: true } })
					},
					// Cloudflare terminates TLS and the connector delivers plain HTTP here, so
					// this server never redirects or asks for certificates. Forwarded headers
					// aren't trusted (service containers share networks with the ingress); the
					// visitor's address arrives in Cloudflare's own CF-Connecting-IP header.
					...(tunnel
						? {
								tunnel: {
									listen: [`:${tunnel.port}`],
									routes: routesFor(tunnel.routes, true, { behindTls: true }),
									logs: { default_logger_name: TUNNEL_LOGGER },
									automatic_https: { disable: true }
								}
							}
						: {})
				}
			}
		}
	};
}
