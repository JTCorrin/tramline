import { api } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, data }) => {
	const client = api(fetch);
	const none = Promise.resolve([]);
	const [nodes, admins, adapters, accounts, provisioning] = await Promise.all([
		client.nodes.getAll(),
		data.canManage ? client.install.admins() : none,
		data.canManage ? client.adapters.getAll() : none,
		data.canManage ? client.adapters.accounts() : none,
		data.canManage ? client.adapters.provisioning() : none
	]);
	return { ...data, nodes, admins, adapters, accounts, provisioning };
};
