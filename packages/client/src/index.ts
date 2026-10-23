import { createHttp, type ClientOptions } from './http';
import { deployments } from './resources/deployments';
import { environments } from './resources/environments';
import { projects } from './resources/projects';
import { services } from './resources/services';
import { variables } from './resources/variables';

export { ApiError, createHttp, type ClientOptions, type Http, type Query } from './http';
export { defineResource, type Resource } from './resource';

export function createClient(options: ClientOptions) {
	const http = createHttp(options);
	return {
		projects: projects(http),
		environments: environments(http),
		services: services(http),
		variables: variables(http),
		deployments: deployments(http)
	};
}

export type TramlineClient = ReturnType<typeof createClient>;
