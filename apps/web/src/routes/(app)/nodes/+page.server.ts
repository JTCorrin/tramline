import { secrets } from '#lib/server/api/handler.js';
import { db } from '#lib/server/db/index.js';
import { admins } from '#lib/server/domain/index.js';
import { settings } from '#lib/server/settings.server.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { user } = await parent();
	const ctx = { db, secrets, settings, userId: user.id, organizationId: '' };
	return { canManage: admins.isInstallAdmin(ctx), awaitingSetup: admins.awaitingSetup(ctx) };
};
