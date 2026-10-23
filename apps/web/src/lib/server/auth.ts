import { getRequestEvent } from '$app/server';
import {
	GITHUB_CLIENT_ID,
	GITHUB_CLIENT_SECRET,
	TRAMLINE_SECRET_KEY,
	TRAMLINE_URL
} from '$app/env/private';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { organization } from 'better-auth/plugins';
import { db, schema } from './db';

export const githubAuthEnabled = Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);

export const auth = betterAuth({
	appName: 'Tramline',
	baseURL: TRAMLINE_URL,
	secret: TRAMLINE_SECRET_KEY,
	database: drizzleAdapter(db, { provider: 'sqlite', schema }),
	emailAndPassword: { enabled: true },
	socialProviders: githubAuthEnabled
		? { github: { clientId: GITHUB_CLIENT_ID!, clientSecret: GITHUB_CLIENT_SECRET! } }
		: {},
	plugins: [
		organization(),
		// must be last so cookies set by server-side auth.api calls reach the response
		sveltekitCookies(getRequestEvent)
	]
});

export type Session = typeof auth.$Infer.Session;
