import { api, ApiError } from '#lib/api.js';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, parent, url }) => {
	await parent();
	const client = api(fetch);
	try {
		const [project, environments] = await Promise.all([
			client.projects.get(params.id),
			client.environments.getAll({ projectId: params.id })
		]);
		const requested = url.searchParams.get('env');
		const environmentId = environments.some((env) => env.id === requested)
			? requested!
			: environments[0]!.id;
		const [canvas, changes] = await Promise.all([
			client.environments.canvas(environmentId),
			client.environments.changes(environmentId)
		]);
		return { project, environments, environmentId, canvas, changes };
	} catch (e) {
		if (e instanceof ApiError && e.status === 404) error(404, 'Project not found');
		throw e;
	}
};
