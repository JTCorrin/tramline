import { api } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, parent }) => {
	await parent();
	const client = api(fetch);
	const [github, backups] = await Promise.all([client.github.status(), client.backups.storage()]);
	return { github, backups };
};
