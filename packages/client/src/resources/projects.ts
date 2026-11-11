import type { CreateProject, Project, ProjectCosts, UpdateProject } from '@tramline/contracts';
import type { Http } from '../http';
import { defineResource } from '../resource';

const base = defineResource<Project, CreateProject, UpdateProject>('/projects');

export const projects = (http: Http) => ({
	...base(http),
	/** What the project costs a month, environment by environment. */
	costs: (id: string) => http.get<ProjectCosts>(`/projects/${id}/costs`)
});
