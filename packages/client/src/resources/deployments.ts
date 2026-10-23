import type { Deployment, DeploymentQuery } from '@tramline/contracts';
import type { Http } from '../http';

export const deployments = (http: Http) => ({
	getAll: (query: DeploymentQuery) => http.get<Deployment[]>('/deployments', query),
	get: (id: string) => http.get<Deployment>(`/deployments/${id}`),
	/** Queues a copy: a restart for the latest deployment, a rollback for older ones. */
	redeploy: (id: string) => http.post<Deployment>(`/deployments/${id}/redeploy`),
	/** Stops the deployment's containers. */
	remove: (id: string) => http.post<Deployment>(`/deployments/${id}/remove`),
	/** Path of the server-sent events stream of this deployment's logs. */
	logsPath: (id: string) => `/deployments/${id}/logs`
});
