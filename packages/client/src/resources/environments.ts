import type {
	Canvas,
	CreateEnvironment,
	Deployment,
	Environment,
	StagedChanges,
	UpdateEnvironment
} from '@tramline/contracts';
import type { Http } from '../http';
import { defineResource } from '../resource';

const base = defineResource<
	Environment,
	CreateEnvironment,
	UpdateEnvironment,
	{ projectId: string }
>('/environments');

export const environments = (http: Http) => ({
	...base(http),
	/** Service nodes and reference edges for the project canvas. */
	canvas: (id: string) => http.get<Canvas>(`/environments/${id}/canvas`),
	/** Staged, not yet deployed changes. */
	changes: (id: string) => http.get<StagedChanges>(`/environments/${id}/changes`),
	discard: (id: string) => http.delete<void>(`/environments/${id}/changes`),
	/** Applies staged changes and queues deployments. */
	deploy: (id: string) => http.post<Deployment[]>(`/environments/${id}/deploy`)
});
