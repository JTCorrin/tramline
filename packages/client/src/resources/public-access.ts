import type {
	CloudflareZone,
	CreatePublicTunnel,
	ListCloudflareZones,
	PublicAccess,
	TunnelConnector,
	UpdatePublicTunnel
} from '@tramline/contracts';
import type { Http } from '../http';

/** Where nodes reach this install, and the tunnel Tramline can set up for it (install admins only). */
export const publicAccess = (http: Http) => ({
	get: () => http.get<PublicAccess>('/public-access'),
	/** The domains a Cloudflare API token can manage. */
	cloudflareZones: (input: ListCloudflareZones) =>
		http.post<CloudflareZone[]>('/public-access/cloudflare/zones', input),
	createTunnel: (input: CreatePublicTunnel) =>
		http.post<PublicAccess>('/public-access/tunnel', input),
	updateTunnel: (input: UpdatePublicTunnel) =>
		http.patch<PublicAccess>('/public-access/tunnel', input),
	/** `force` forgets the tunnel even when Cloudflare can't remove it. */
	removeTunnel: ({ force = false } = {}) =>
		http.delete<void>(`/public-access/tunnel${force ? '?force=true' : ''}`),
	/** Reveals the tunnel token, for running the connector by hand. */
	connector: () => http.post<TunnelConnector>('/public-access/tunnel/connector')
});
