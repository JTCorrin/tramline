/** Install-wide settings that domain code needs; built from env in `settings.server`, by hand in tests. */
export interface PlatformSettings {
	/** Wildcard domain for generated service hostnames. */
	baseDomain: string;
	/** Host port of the ingress proxy (HTTP). */
	ingressPort: number;
	/** Where deployment logs and the local agent token are written. */
	dataDir: string;
	/** Public URL of this install (TRAMLINE_URL), for GitHub callbacks and webhooks. */
	publicUrl: string | null;
	/** Where nodes reach this install (TRAMLINE_AGENT_URL), when not `publicUrl`. */
	agentUrl?: string | null;
	/** Who may create an account (TRAMLINE_SIGNUP): anyone, or only people with an invite. */
	signup?: 'open' | 'invite';
	/** Access logs; absent in tests that don't need them. */
	traffic?: TrafficSettings;
}

export interface TrafficSettings {
	/** TRAMLINE_ACCESS_LOG_DAYS: 0 keeps none. */
	retentionDays: number;
	/** TRAMLINE_ACCESS_LOG_MAX_ROWS */
	maxRows: number;
	/** TRAMLINE_ANONYMIZE_IPS */
	anonymize: boolean;
	/** TRAMLINE_TRUSTED_PROXIES */
	trustedProxies: string[];
	/** TRAMLINE_ASN_DATA_URL; null turns network names off. */
	asnUrl: string | null;
}

export const DEFAULT_TRAFFIC: TrafficSettings = {
	retentionDays: 14,
	maxRows: 2_000_000,
	anonymize: false,
	trustedProxies: [],
	asnUrl: null
};

/** GitHub can only deliver webhooks to an address it can reach. */
export const reachableFromInternet = (settings: PlatformSettings) => {
	if (!settings.publicUrl) return false;
	const { protocol, hostname } = new URL(settings.publicUrl);
	return (
		protocol === 'https:' &&
		!['localhost', '127.0.0.1', '[::1]'].includes(hostname) &&
		!hostname.endsWith('.localhost') &&
		!hostname.endsWith('.local')
	);
};

/** `localhost` style domains are served over plain HTTP; real domains get automatic HTTPS. */
export const usesTls = (settings: PlatformSettings) =>
	!(settings.baseDomain === 'localhost' || settings.baseDomain.endsWith('.localhost'));

export function publicUrl(settings: PlatformSettings, host: string) {
	if (usesTls(settings)) return `https://${host}`;
	return `http://${host}${settings.ingressPort === 80 ? '' : `:${settings.ingressPort}`}`;
}

/**
 * Where the TCP proxy is reached: the service's own domain when it has one
 * (it points at the edge nodes), else the base domain.
 */
export const tcpProxyHost = (settings: PlatformSettings, domain: string | null) =>
	domain ?? settings.baseDomain;
