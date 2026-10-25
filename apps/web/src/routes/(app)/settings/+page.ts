import { api } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, parent, data }) => {
	await parent();
	const client = api(fetch);
	const [github, backups, tokens] = await Promise.all([
		client.github.status(),
		client.backups.storage(),
		client.tokens.getAll()
	]);
	// only owners and admins may read the audit log or manage GitHub Actions access
	const [audit, trust] = github.canManage
		? await Promise.all([client.tokens.auditLog(), client.oidc.trust()])
		: [null, null];
	return { ...data, github, backups, tokens, audit, trust };
};
