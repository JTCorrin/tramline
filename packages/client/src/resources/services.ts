import type {
	CreateService,
	Deployment,
	Service,
	ServiceConfigPatch,
	ServiceConfigView,
	UpdateService
} from '@tramline/contracts';
import type { Http } from '../http';
import { defineResource } from '../resource';

const base = defineResource<Service, CreateService, UpdateService, { projectId: string }>(
	'/services'
);

export const services = (http: Http) => ({
	...base(http),
	config: (id: string, environmentId: string) =>
		http.get<ServiceConfigView>(`/services/${id}/config`, { environmentId }),
	/** Deploys the service as deployed now, optionally at a commit (for CI). */
	deploy: (id: string, input: { environmentId: string; commit?: string | null }) =>
		http.post<Deployment>(`/services/${id}/deploy`, input),
	/** Stages a config change; it applies on the environment's next deploy. */
	stageConfig: (id: string, environmentId: string, patch: ServiceConfigPatch) =>
		http.patch<ServiceConfigView>(
			`/services/${id}/config?environmentId=${encodeURIComponent(environmentId)}`,
			patch
		)
});
