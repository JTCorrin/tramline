import type { CreateNodePool, NodePool, UpdateNodePool } from '@tramline/contracts';
import type { Http } from '../http';

/** Node pools: machines Tramline adds and removes by itself (install admins only). */
export const pools = (http: Http) => ({
	getAll: () => http.get<NodePool[]>('/node-pools'),
	create: (input: CreateNodePool) => http.post<NodePool>('/node-pools', input),
	update: (id: string, input: UpdateNodePool) => http.patch<NodePool>(`/node-pools/${id}`, input),
	/** The pool as it drains, or nothing once it's gone. */
	remove: (id: string) => http.delete<NodePool | undefined>(`/node-pools/${id}`)
});
