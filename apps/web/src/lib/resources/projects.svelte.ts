import type { CreateProject, Project, UpdateProject } from '@tramline/contracts';
import { api } from '#lib/api.js';
import { Collection } from './collection.svelte';

export const projectCollection = (initial: Project[]) =>
	new Collection<Project, CreateProject, UpdateProject>(api().projects, initial);
