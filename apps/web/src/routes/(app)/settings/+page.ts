import { api } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, parent }) => {
	await parent();
	const client = api(fetch);
	const [github, backups, tokens] = await Promise.all([
		client.github.status(),
		client.backups.storage(),
		client.tokens.getAll()
	]);
	// only owners and admins may read the audit log
	const audit = github.canManage ? await client.tokens.auditLog() : null;
	return { github, backups, tokens, audit };
};
