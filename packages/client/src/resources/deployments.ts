import type { Deployment, DeploymentQuery } from '@tramline/contracts';
import type { Http } from '../http';

export const deployments = (http: Http) => ({
	getAll: (query: DeploymentQuery) => http.get<Deployment[]>('/deployments', query)
});
