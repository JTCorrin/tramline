import { api } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, data }) => {
	const client = api(fetch);
	const none = Promise.resolve([]);
	const [nodes, admins, adapters, accounts, provisioning, access, pools] = await Promise.all([
		client.nodes.getAll(),
		data.canManage ? client.install.admins() : none,
		data.canManage ? client.adapters.getAll() : none,
		data.canManage ? client.adapters.accounts() : none,
		data.canManage ? client.adapters.provisioning() : none,
		data.canManage ? client.publicAccess.get() : Promise.resolve(null),
		data.canManage ? client.pools.getAll() : none
	]);
	return { ...data, nodes, admins, adapters, accounts, provisioning, access, pools };
};
