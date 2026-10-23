import { createHttp, type ClientOptions } from './http';
import { projects } from './resources/projects';

export { ApiError, createHttp, type ClientOptions, type Http, type Query } from './http';
export { defineResource, type Resource } from './resource';

export function createClient(options: ClientOptions) {
	const http = createHttp(options);
	return {
		projects: projects(http)
	};
}

export type TramlineClient = ReturnType<typeof createClient>;
