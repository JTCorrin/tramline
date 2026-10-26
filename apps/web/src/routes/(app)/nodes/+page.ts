import { api } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, data }) => {
	const client = api(fetch);
	const [nodes, admins] = await Promise.all([
		client.nodes.getAll(),
		data.canManage ? client.install.admins() : Promise.resolve([])
	]);
	return { ...data, nodes, admins };
};
