import type { InstallTemplate, InstalledTemplate, TemplateSummary } from '@tramline/contracts';
import type { Http } from '../http';

export const templates = (http: Http) => ({
	/** The template gallery. */
	list: () => http.get<TemplateSummary[]>('/templates'),
	get: (id: string) => http.get<TemplateSummary>(`/templates/${id}`),
	/** Adds a template's services to a project, staged in every environment. */
	install: (projectId: string, input: InstallTemplate) =>
		http.post<InstalledTemplate>(`/projects/${projectId}/templates`, input)
});
