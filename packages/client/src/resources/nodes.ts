import type { NodeSummary } from '@tramline/contracts';
import type { Http } from '../http';

export const nodes = (http: Http) => ({
	getAll: () => http.get<NodeSummary[]>('/nodes')
});
