import { settings } from '#lib/server/settings.server.js';
import type { PageServerLoad } from './$types';

/** The audience GitHub Actions workflows request tokens for: this install's address. */
export const load: PageServerLoad = () => ({
	oidcAudience: settings.publicUrl ? new URL(settings.publicUrl).origin : null
});
