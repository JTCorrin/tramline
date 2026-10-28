import type { Http } from '../http';

export interface Invite {
	id: string;
	role: 'member' | 'admin';
	createdBy: string | null;
	expiresAt: string;
	createdAt: string;
}

/** One-time links to join the organization (and sign up, when sign-up is by invitation). */
export const invites = (http: Http) => ({
	getAll: () => http.get<Invite[]>('/invites'),
	/** The response's `url` is the only copy of the link. */
	create: (role: 'member' | 'admin') => http.post<Invite & { url: string }>('/invites', { role }),
	revoke: (id: string) => http.delete<void>(`/invites/${id}`)
});
