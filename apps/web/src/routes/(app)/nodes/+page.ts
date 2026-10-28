import { api } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, data }) => ({
	...data,
	nodes: await api(fetch).nodes.getAll()
});
