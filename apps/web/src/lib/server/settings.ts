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
	/** Who may create an account (TRAMLINE_SIGNUP): anyone, or only people with an invite. */
	signup?: 'open' | 'invite';
}

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
