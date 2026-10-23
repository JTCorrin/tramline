import type { CreateProject, Project, UpdateProject } from '@tramline/contracts';
import { defineResource } from '../resource';

export const projects = defineResource<Project, CreateProject, UpdateProject>('/projects');
