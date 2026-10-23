import { api, ApiError } from '#lib/api.js';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, parent }) => {
	await parent();
	try {
		return { project: await api(fetch).projects.get(params.id) };
	} catch (e) {
		if (e instanceof ApiError && e.status === 404) error(404, 'Project not found');
		throw e;
	}
};
