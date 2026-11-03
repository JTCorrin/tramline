import { z } from 'zod';

/**
 * Public access: the address nodes elsewhere use to reach this install. It
 * can be a tunnel Tramline sets up with Cloudflare, so an install at home or
 * behind NAT needs no open port. The tunnel only carries what nodes need
 * (the agent API and the install script), not the dashboard.
 */

/** Paths the tunnel carries; everything else on its hostname gets a 404. */
export const TUNNEL_PATHS = '^/(api/agent/|install\\.sh$)';

export const TunnelStatus = z.enum(['healthy', 'degraded', 'down', 'inactive', 'unknown']);
export type TunnelStatus = z.infer<typeof TunnelStatus>;

export const PublicTunnel = z.object({
	provider: z.literal('cloudflare'),
	hostname: z.string(),
	zoneName: z.string(),
	/** Where the connector reaches this install. */
	originUrl: z.string(),
	/** The node running the connector; null when it's run by hand. */
	nodeId: z.string().nullable(),
	nodeName: z.string().nullable(),
	/** Cloudflare's view: `inactive` until a connector has connected. */
	status: TunnelStatus,
	createdAt: z.string()
});
export type PublicTunnel = z.infer<typeof PublicTunnel>;

export const PublicAccess = z.object({
	/** What new nodes are told to connect to; null means the address in the browser. */
	agentUrl: z.string().nullable(),
	/** Where `agentUrl` comes from. */
	source: z.enum(['tunnel', 'env', 'browser']),
	tunnel: PublicTunnel.nullable()
});
export type PublicAccess = z.infer<typeof PublicAccess>;

/**
 * Copied tokens pick up line breaks, and Cloudflare's "test this token" curl
 * command has it after `Bearer `; take the token out of either.
 */
const ApiToken = z
	.string()
	.transform((value) => {
		const bearer = value.match(/Bearer\s+([A-Za-z0-9_-]+)/);
		return (bearer ? bearer[1]! : value).replace(/\s+/g, '');
	})
	.pipe(
		z
			.string()
			.min(20, 'Paste the whole API token')
			.max(200)
			.regex(/^[A-Za-z0-9_-]+$/, 'An API token is only letters, digits, - and _')
	);

export const ListCloudflareZones = z.object({ apiToken: ApiToken });
export type ListCloudflareZones = z.infer<typeof ListCloudflareZones>;

export const CloudflareZone = z.object({
	id: z.string(),
	name: z.string(),
	accountId: z.string(),
	accountName: z.string()
});
export type CloudflareZone = z.infer<typeof CloudflareZone>;

const OriginUrl = z
	.string()
	.trim()
	.pipe(z.url({ protocol: /^https?$/, error: 'Use an http:// or https:// address' }))
	.transform((url) => url.replace(/\/$/, ''));

export const CreatePublicTunnel = z.object({
	apiToken: ApiToken,
	zoneId: z.string().min(1),
	/** A name under the zone, e.g. `tramline` for tramline.example.com; empty for the zone itself. */
	subdomain: z
		.string()
		.trim()
		.toLowerCase()
		// a hostname's length cap, checked before the pattern ever runs
		.max(200, 'That name is too long')
		.pipe(
			z
				.string()
				.regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$|^$/, {
					message: 'Use letters, digits, hyphens and dots'
				})
		),
	originUrl: OriginUrl,
	nodeId: z.string().nullable()
});
export type CreatePublicTunnel = z.infer<typeof CreatePublicTunnel>;

export const UpdatePublicTunnel = z.object({
	originUrl: OriginUrl.optional(),
	nodeId: z.string().nullable().optional()
});
export type UpdatePublicTunnel = z.infer<typeof UpdatePublicTunnel>;

/** For running the connector by hand: the only place the tunnel token is shown. */
export const TunnelConnector = z.object({ token: z.string(), command: z.string() });
export type TunnelConnector = z.infer<typeof TunnelConnector>;
