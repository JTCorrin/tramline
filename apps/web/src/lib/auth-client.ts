import { passkeyClient } from '@better-auth/passkey/client';
import { organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/svelte';

export const authClient = createAuthClient({
	plugins: [organizationClient(), twoFactorClient(), passkeyClient()]
});
