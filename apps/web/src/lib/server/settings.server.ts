import {
	TRAMLINE_ADMIN_EMAILS,
	TRAMLINE_BASE_DOMAIN,
	TRAMLINE_DATA_DIR,
	TRAMLINE_INGRESS_PORT,
	TRAMLINE_URL
} from '$app/env/private';
import type { PlatformSettings } from './settings';

export const settings: PlatformSettings = {
	baseDomain: TRAMLINE_BASE_DOMAIN,
	ingressPort: TRAMLINE_INGRESS_PORT,
	dataDir: TRAMLINE_DATA_DIR,
	publicUrl: TRAMLINE_URL ?? null,
	adminEmails: TRAMLINE_ADMIN_EMAILS
};
