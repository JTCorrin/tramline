import { getRequestEvent } from '$app/server';
import {
	GITHUB_CLIENT_ID,
	GITHUB_CLIENT_SECRET,
	TRAMLINE_AUTH_RATE_LIMIT,
	TRAMLINE_SECRET_KEY,
	TRAMLINE_URL
} from '$app/env/private';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { organization, twoFactor } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { APIError } from 'better-auth/api';
import { db, schema } from './db';
import { findInvite, INVITE_COOKIE, redeem, signupAllowed } from './domain/invites';
import { settings } from './settings.server';

/** The invite token from the cookie set by an invite link. */
function inviteFrom(context: { headers?: Headers; request?: Request } | null) {
	const cookie = (context?.headers ?? context?.request?.headers)?.get('cookie') ?? '';
	const match = cookie.match(new RegExp(`(?:^|;\\s*)${INVITE_COOKIE}=([^;]+)`));
	return match ? decodeURIComponent(match[1]!) : null;
}

export const githubAuthEnabled = Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);

export const auth = betterAuth({
	appName: 'Tramline',
	baseURL: TRAMLINE_URL,
	secret: TRAMLINE_SECRET_KEY,
	database: drizzleAdapter(db, { provider: 'sqlite', schema }),
	emailAndPassword: { enabled: true },
	// better-auth enables this in production by default; the e2e suite turns it off
	rateLimit: TRAMLINE_AUTH_RATE_LIMIT ? undefined : { enabled: false },
	socialProviders: githubAuthEnabled
		? { github: { clientId: GITHUB_CLIENT_ID!, clientSecret: GITHUB_CLIENT_SECRET! } }
		: {},
	databaseHooks: {
		user: {
			create: {
				// sign-up by invitation: email and GitHub alike need an invite cookie once the install
				// has an admin (unless TRAMLINE_SIGNUP=open)
				before: async (_user, context) => {
					if (!signupAllowed(db, settings, inviteFrom(context))) {
						throw new APIError('FORBIDDEN', {
							message:
								'Sign-up on this Tramline is by invitation. Ask an organization owner for a link.'
						});
					}
				},
				// an invited person joins the organization that invited them
				after: async (created, context) => {
					const token = inviteFrom(context);
					if (token && findInvite(db, token)) redeem(db, token, created.id);
				}
			}
		}
	},
	plugins: [
		organization(),
		// TOTP with backup codes; the secret is encrypted by better-auth with TRAMLINE_SECRET_KEY
		twoFactor({ issuer: 'Tramline' }),
		// WebAuthn credentials are tied to this install's hostname
		passkey({
			rpID: new URL(TRAMLINE_URL ?? 'http://localhost').hostname,
			rpName: 'Tramline',
			origin: TRAMLINE_URL ? new URL(TRAMLINE_URL).origin : undefined
		}),
		// must be last so cookies set by server-side auth.api calls reach the response
		sveltekitCookies(getRequestEvent)
	]
});

export type Session = typeof auth.$Infer.Session;
