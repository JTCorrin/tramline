import type { Http } from '../http';

export interface InstallAdmin {
	userId: string;
	name: string;
	email: string;
	grantedAt: string;
}

/** Install-wide administration: who manages the nodes every organization runs on. */
export const install = (http: Http) => ({
	claim: (token: string) => http.post<void>('/install/claim', { token }),
	admins: () => http.get<InstallAdmin[]>('/install/admins'),
	grant: (email: string) => http.post<InstallAdmin[]>('/install/admins', { email }),
	revoke: (userId: string) => http.delete<InstallAdmin[]>(`/install/admins/${userId}`)
});
