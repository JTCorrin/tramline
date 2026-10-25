import type { ApiToken, AuditEvent, CreateApiToken, CreatedApiToken } from '@tramline/contracts';
import type { Http } from '../http';

export const tokens = (http: Http) => ({
	getAll: () => http.get<ApiToken[]>('/tokens'),
	/** The response holds the token's secret; it is never shown again. */
	create: (input: CreateApiToken) => http.post<CreatedApiToken>('/tokens', input),
	revoke: (id: string) => http.delete<void>(`/tokens/${id}`),
	auditLog: () => http.get<AuditEvent[]>('/audit-log')
});
