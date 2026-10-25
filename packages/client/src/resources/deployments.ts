import type { CronRun, Deployment, DeploymentQuery, LogLine } from '@tramline/contracts';
import type { Http } from '../http';

export const deployments = (http: Http) => ({
	getAll: (query: DeploymentQuery) => http.get<Deployment[]>('/deployments', query),
	get: (id: string) => http.get<Deployment>(`/deployments/${id}`),
	/** Queues a copy: a restart for the latest deployment, a rollback for older ones. */
	redeploy: (id: string) => http.post<Deployment>(`/deployments/${id}/redeploy`),
	/** Stops the deployment's containers. */
	remove: (id: string) => http.post<Deployment>(`/deployments/${id}/remove`),
	runs: (id: string) => http.get<CronRun[]>(`/deployments/${id}/runs`),
	runNow: (id: string) => http.post<CronRun>(`/deployments/${id}/runs`),
	/** The last `tail` log lines. */
	logs: (id: string, tail = 200) =>
		http.get<LogLine[]>(`/deployments/${id}/logs`, { format: 'json', tail }),
	/** Path of the server-sent events stream of this deployment's logs. */
	logsPath: (id: string) => `/deployments/${id}/logs`
});
