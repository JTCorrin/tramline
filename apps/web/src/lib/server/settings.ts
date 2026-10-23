/** Install-wide settings that domain code needs; built from env in `settings.server`, by hand in tests. */
export interface PlatformSettings {
	/** Wildcard domain for generated service hostnames. */
	baseDomain: string;
	/** Host port of the ingress proxy (HTTP). */
	ingressPort: number;
	/** Where deployment logs and the local agent token are written. */
	dataDir: string;
}

/** `localhost` style domains are served over plain HTTP; real domains get automatic HTTPS. */
export const usesTls = (settings: PlatformSettings) =>
	!(settings.baseDomain === 'localhost' || settings.baseDomain.endsWith('.localhost'));

export function publicUrl(settings: PlatformSettings, host: string) {
	if (usesTls(settings)) return `https://${host}`;
	return `http://${host}${settings.ingressPort === 80 ? '' : `:${settings.ingressPort}`}`;
}
