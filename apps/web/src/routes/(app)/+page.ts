import { api } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, parent }) => {
	// the layout makes sure an organization is active before we list its projects
	await parent();
	return { projects: await api(fetch).projects.getAll() };
};
