import type { AddCustomDomain, CustomDomain, CustomDomainQuery } from '@tramline/contracts';
import type { Http } from '../http';

export const domains = (http: Http) => ({
	getAll: (query: CustomDomainQuery) => http.get<CustomDomain[]>('/domains', query),
	create: (input: AddCustomDomain) => http.post<CustomDomain>('/domains', input),
	remove: (id: string) => http.delete<void>(`/domains/${id}`),
	verify: (id: string) => http.post<CustomDomain>(`/domains/${id}/verify`)
});
