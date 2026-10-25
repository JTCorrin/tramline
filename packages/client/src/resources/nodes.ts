import type {
	CreatedJoinToken,
	CreateJoinToken,
	DrainResult,
	NodeSummary,
	UpdateNode
} from '@tramline/contracts';
import type { Http } from '../http';

export const nodes = (http: Http) => ({
	getAll: () => http.get<NodeSummary[]>('/nodes'),
	/** A one-time join token; the response holds the only copy. */
	join: (input: CreateJoinToken) => http.post<CreatedJoinToken>('/nodes', input),
	update: (id: string, input: UpdateNode) => http.patch<NodeSummary>(`/nodes/${id}`, input),
	drain: (id: string) => http.post<DrainResult>(`/nodes/${id}/drain`),
	remove: (id: string) => http.delete<void>(`/nodes/${id}`)
});
