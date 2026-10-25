import type { CreateOidcTrust, OidcExchange, OidcTrust } from '@tramline/contracts';
import type { Http } from '../http';

export const oidc = (http: Http) => ({
	trust: () => http.get<OidcTrust[]>('/oidc/trust'),
	createTrust: (input: CreateOidcTrust) => http.post<OidcTrust>('/oidc/trust', input),
	removeTrust: (id: string) => http.delete<void>(`/oidc/trust/${id}`),
	/** Trades a GitHub Actions OIDC token for a short-lived API token. */
	exchangeGitHub: (token: string) => http.post<OidcExchange>('/oidc/github', { token })
});
