import { AppError } from './api/errors';

/**
 * The few Cloudflare API calls a tunnel needs: list zones, create a
 * remotely-managed tunnel with its ingress rules, point a DNS name at it,
 * and remove both again. The API token needs Cloudflare Tunnel: Edit on the
 * account and DNS: Edit on the zone.
 */

const API = 'https://api.cloudflare.com/client/v4';

interface Envelope<T> {
	success: boolean;
	errors?: { code: number; message: string }[];
	result: T;
	result_info?: { page: number; total_pages: number };
}

export interface CloudflareClient {
	zones(): Promise<{ id: string; name: string; accountId: string; accountName: string }[]>;
	zone(id: string): Promise<{ id: string; name: string; accountId: string }>;
	dnsRecordExists(zoneId: string, hostname: string): Promise<boolean>;
	createTunnel(accountId: string, name: string): Promise<{ id: string }>;
	configureTunnel(
		accountId: string,
		tunnelId: string,
		ingress: { hostname?: string; path?: string; service: string }[]
	): Promise<void>;
	tunnelToken(accountId: string, tunnelId: string): Promise<string>;
	tunnelStatus(accountId: string, tunnelId: string): Promise<string>;
	deleteTunnel(accountId: string, tunnelId: string): Promise<void>;
	createCname(zoneId: string, hostname: string, target: string): Promise<{ id: string }>;
	deleteDnsRecord(zoneId: string, id: string): Promise<void>;
}

/** Cloudflare's own message, e.g. "Authentication error", as a Tramline error. */
function failure(status: number, body: Envelope<unknown> | null, what: string) {
	const message = body?.errors?.map((e) => e.message).join('; ') || `HTTP ${status}`;
	// 6003: a malformed Authorization header; 9109: an unknown or revoked token
	const tokenCodes = [6003, 9109, 10000];
	if (status === 401 || status === 403 || body?.errors?.some((e) => tokenCodes.includes(e.code))) {
		return new AppError(
			'validation_failed',
			`Cloudflare refused the API token while trying to ${what}: ${message}`
		);
	}
	return new AppError('bad_request', `Cloudflare couldn’t ${what}: ${message}`);
}

export function cloudflare(apiToken: string, fetcher: typeof fetch = fetch): CloudflareClient {
	async function call<T>(
		what: string,
		method: string,
		path: string,
		body?: unknown,
		{ allowMissing = false } = {}
	): Promise<Envelope<T> | null> {
		let response: Response;
		try {
			response = await fetcher(API + path, {
				method,
				headers: {
					authorization: `Bearer ${apiToken}`,
					...(body === undefined ? {} : { 'content-type': 'application/json' })
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(20_000)
			});
		} catch (error) {
			throw new AppError(
				'bad_request',
				`Couldn’t reach Cloudflare to ${what}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		if (allowMissing && response.status === 404) return null;
		const parsed = (await response.json().catch(() => null)) as Envelope<T> | null;
		if (!response.ok || !parsed?.success) throw failure(response.status, parsed, what);
		return parsed;
	}

	const get = async <T>(what: string, path: string) => (await call<T>(what, 'GET', path))!.result;

	return {
		async zones() {
			type Zone = { id: string; name: string; account: { id: string; name: string } };
			const zones: Zone[] = [];
			for (let page = 1; ; page++) {
				const res = (await call<Zone[]>(
					'list your domains',
					'GET',
					`/zones?per_page=50&page=${page}&status=active`
				))!;
				zones.push(...res.result);
				if (!res.result_info || page >= res.result_info.total_pages) break;
			}
			return zones.map((z) => ({
				id: z.id,
				name: z.name,
				accountId: z.account.id,
				accountName: z.account.name
			}));
		},
		async zone(id) {
			const z = await get<{ id: string; name: string; account: { id: string } }>(
				'read the domain',
				`/zones/${encodeURIComponent(id)}`
			);
			return { id: z.id, name: z.name, accountId: z.account.id };
		},
		async dnsRecordExists(zoneId, hostname) {
			const records = await get<unknown[]>(
				'check the DNS records',
				`/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(hostname)}`
			);
			return records.length > 0;
		},
		async createTunnel(accountId, name) {
			return (await call<{ id: string }>(
				'create the tunnel',
				'POST',
				`/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`,
				{ name, config_src: 'cloudflare' }
			))!.result;
		},
		async configureTunnel(accountId, tunnelId, ingress) {
			await call(
				'set the tunnel’s routes',
				'PUT',
				`/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
				{ config: { ingress } }
			);
		},
		tunnelToken: (accountId, tunnelId) =>
			get<string>(
				'read the tunnel token',
				`/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`
			),
		async tunnelStatus(accountId, tunnelId) {
			const tunnel = await get<{ status: string }>(
				'read the tunnel',
				`/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`
			);
			return tunnel.status;
		},
		async deleteTunnel(accountId, tunnelId) {
			const base = `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`;
			// a tunnel with connectors still attached can't be deleted
			await call('disconnect the tunnel', 'DELETE', `${base}/connections`, undefined, {
				allowMissing: true
			});
			await call('delete the tunnel', 'DELETE', base, undefined, { allowMissing: true });
		},
		async createCname(zoneId, hostname, target) {
			return (await call<{ id: string }>(
				'create the DNS record',
				'POST',
				`/zones/${encodeURIComponent(zoneId)}/dns_records`,
				{
					type: 'CNAME',
					name: hostname,
					content: target,
					proxied: true,
					comment: 'Tramline tunnel'
				}
			))!.result;
		},
		async deleteDnsRecord(zoneId, id) {
			await call(
				'delete the DNS record',
				'DELETE',
				`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`,
				undefined,
				{ allowMissing: true }
			);
		}
	};
}
