import { db, schema } from '#lib/server/db/index.js';
import { resetTokenCache } from '#lib/server/github/app.js';
import { seedCtx, testSecrets } from '#lib/server/testing.js';
import { isRedirect, type RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as status from '../v1/github/+server';
import * as manifestStart from '../v1/github/manifest/+server';
import * as install from './install/+server';
import * as manifest from './manifest/+server';
import * as setup from './setup/+server';
import * as callback from './callback/+server';
import * as webhook from './webhook/+server';

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
	.privateKey.export({ type: 'pkcs1', format: 'pem' })
	.toString();

type Handler = (event: never) => Response | Promise<Response>;

/** Calls a route with cookies, catching SvelteKit redirects. */
async function call(
	handler: Handler,
	options: {
		path: string;
		method?: string;
		body?: string;
		headers?: Record<string, string>;
		user?: ReturnType<typeof seedCtx>;
		cookies?: Record<string, string>;
	}
) {
	const url = new URL(`http://localhost${options.path}`);
	const jar = { ...options.cookies };
	const cookies = {
		get: (name: string) => jar[name],
		set: (name: string, value: string) => {
			jar[name] = value;
		},
		delete: (name: string) => {
			delete jar[name];
		}
	};
	const locals = options.user
		? {
				user: { id: options.user.userId },
				session: { activeOrganizationId: options.user.organizationId }
			}
		: { user: null, session: null };
	const request = new Request(url, {
		method: options.method ?? 'GET',
		headers: options.headers,
		body: options.body
	});
	try {
		const response = await handler({
			request,
			url,
			params: {},
			locals,
			cookies
		} as unknown as RequestEvent as never);
		const json = response.headers.get('content-type')?.includes('json')
			? await response.json()
			: null;
		return { status: response.status, body: json, location: null as string | null, jar };
	} catch (error) {
		if (isRedirect(error))
			return { status: error.status, body: null, location: error.location, jar };
		throw error;
	}
}

function seedApp() {
	db.delete(schema.githubApp).run();
	db.insert(schema.githubApp)
		.values({
			id: '42',
			slug: 'tramline-abc',
			name: 'Tramline abc',
			htmlUrl: 'https://github.com/apps/tramline-abc',
			owner: 'acme',
			clientId: 'Iv1.x',
			clientSecret: testSecrets.encrypt('s'),
			privateKey: testSecrets.encrypt(PEM),
			webhookSecret: testSecrets.encrypt('hook-secret')
		})
		.run();
}

const signed = (body: object, event: string, secret = 'hook-secret') => {
	const text = JSON.stringify(body);
	return {
		body: text,
		headers: {
			'x-github-event': event,
			'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(text).digest('hex')}`
		}
	};
};

afterEach(() => {
	vi.restoreAllMocks();
	resetTokenCache();
});

describe('webhook', () => {
	it('rejects unsigned or wrongly signed deliveries', async () => {
		seedApp();
		expect(
			(
				await call(webhook.POST as Handler, {
					path: '/api/github/webhook',
					method: 'POST',
					body: '{}'
				})
			).status
		).toBe(401);
		const forged = signed({ zen: 'x' }, 'ping', 'not-the-secret');
		expect(
			(
				await call(webhook.POST as Handler, {
					path: '/api/github/webhook',
					method: 'POST',
					...forged
				})
			).status
		).toBe(401);
	});

	it('accepts pings, deploys pushes and forgets uninstalled installations', async () => {
		seedApp();
		const ping = signed({ zen: 'Keep it logically awesome.' }, 'ping');
		expect(
			(
				await call(webhook.POST as Handler, {
					path: '/api/github/webhook',
					method: 'POST',
					...ping
				})
			).status
		).toBe(204);

		const push = signed(
			{
				ref: 'refs/heads/main',
				after: 'c'.repeat(40),
				repository: { full_name: 'nobody/nothing' },
				commits: []
			},
			'push'
		);
		expect(
			await call(webhook.POST as Handler, { path: '/api/github/webhook', method: 'POST', ...push })
		).toMatchObject({
			status: 202,
			body: { deployments: [] }
		});

		const ctx = seedCtx(db);
		db.insert(schema.githubInstallation)
			.values({
				id: '77',
				organizationId: ctx.organizationId,
				account: 'a',
				accountType: 'User',
				htmlUrl: 'x'
			})
			.run();
		const removed = signed({ action: 'deleted', installation: { id: 77 } }, 'installation');
		expect(
			(
				await call(webhook.POST as Handler, {
					path: '/api/github/webhook',
					method: 'POST',
					...removed
				})
			).status
		).toBe(204);
		expect(
			db
				.select()
				.from(schema.githubInstallation)
				.where(eq(schema.githubInstallation.id, '77'))
				.get()
		).toBeUndefined();
	});
});

describe('manifest flow', () => {
	it('issues a state cookie and returns the form to post to GitHub', async () => {
		db.delete(schema.githubApp).run();
		const user = seedCtx(db);
		const res = await call(manifestStart.POST as Handler, {
			path: '/api/v1/github/manifest',
			method: 'POST',
			body: '{}',
			user
		});
		expect(res.status).toBe(201);
		const state = res.jar.tramline_github_state!;
		expect(state).toMatch(/^[\w-]{32}$/);
		expect(res.body.action).toBe(`https://github.com/settings/apps/new?state=${state}`);
	});

	it('sends authorizations without our state (later edits on GitHub) back to settings', async () => {
		const user = seedCtx(db);
		const res = await call(callback.GET as Handler, {
			path: '/api/github/callback?code=c&installation_id=55&setup_action=update',
			user
		});
		expect(res).toMatchObject({ status: 303, location: '/settings' });
	});

	it('refuses callbacks whose state does not match the cookie', async () => {
		db.delete(schema.githubApp).run();
		const user = seedCtx(db);
		const res = await call(manifest.GET as Handler, {
			path: '/api/github/manifest?code=c&state=forged',
			user,
			cookies: { tramline_github_state: 'expected-state' }
		});
		expect(res).toMatchObject({
			status: 403,
			body: { error: { message: expect.stringContaining('expired') } }
		});
	});

	it('stores the app and continues to installing it', async () => {
		db.delete(schema.githubApp).run();
		const user = seedCtx(db);
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			Response.json({
				id: 9,
				slug: 'tramline-new',
				name: 'Tramline new',
				html_url: 'https://github.com/apps/tramline-new',
				owner: { login: 'me' },
				client_id: 'Iv1',
				client_secret: 'cs',
				pem: PEM,
				webhook_secret: 'ws'
			})
		);
		const res = await call(manifest.GET as Handler, {
			path: '/api/github/manifest?code=c&state=good',
			user,
			cookies: { tramline_github_state: 'good' }
		});
		expect(res.status).toBe(303);
		expect(res.location).toBe(
			`https://github.com/apps/tramline-new/installations/new?state=${res.jar.tramline_github_state}`
		);
		expect(res.jar.tramline_github_state).not.toBe('good');
	});

	/** GitHub, for a person who can access installation 55. */
	function fakeGitHub(accessible = [55]) {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/login/oauth/access_token'))
				return Response.json({ access_token: 'ghu_x' });
			if (url.includes('/user/installations')) {
				return Response.json({ installations: accessible.map((id) => ({ id })) });
			}
			return Response.json({
				id: 55,
				account: { login: 'me', type: 'User' },
				html_url: 'https://github.com/settings/installations/55'
			});
		});
	}

	it('connects an installation only after GitHub confirms who is connecting it', async () => {
		seedApp();
		const user = seedCtx(db);
		fakeGitHub();
		// an app that doesn't ask during install: setup sends the browser to authorize first
		const setupRes = await call(setup.GET as Handler, {
			path: '/api/github/setup?installation_id=55&setup_action=install&state=s',
			user,
			cookies: { tramline_github_state: 's' }
		});
		expect(setupRes.status).toBe(303);
		const authorize = new URL(setupRes.location!);
		expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize');
		expect(authorize.searchParams.get('client_id')).toBe('Iv1.x');
		expect(authorize.searchParams.get('redirect_uri')).toBe(
			'http://localhost:5173/api/github/callback'
		);
		expect(setupRes.jar.tramline_github_installation).toBe('55');
		expect(
			(await call(status.GET as Handler, { path: '/api/v1/github', user })).body.installations
		).toEqual([]);

		const state = authorize.searchParams.get('state')!;
		const connected = await call(callback.GET as Handler, {
			path: `/api/github/callback?code=c&state=${state}`,
			user,
			cookies: setupRes.jar
		});
		expect(connected).toMatchObject({ status: 303, location: '/settings?github=connected' });
		expect(
			(await call(status.GET as Handler, { path: '/api/v1/github', user })).body.installations
		).toEqual([expect.objectContaining({ id: '55', account: 'me' })]);

		// edits made later on GitHub come back without our state, and connect nothing
		const edited = await call(setup.GET as Handler, {
			path: '/api/github/setup?installation_id=55&setup_action=update',
			user
		});
		expect(edited).toMatchObject({ status: 303, location: '/settings' });
	});

	it('refuses an installation the person can’t access, or a callback without our state', async () => {
		seedApp();
		const user = seedCtx(db);
		fakeGitHub([1]);
		const refused = await call(callback.GET as Handler, {
			path: '/api/github/callback?code=c&installation_id=55&setup_action=install&state=s',
			user,
			cookies: { tramline_github_state: 's' }
		});
		expect(refused.status).toBe(403);
		const forged = await call(callback.GET as Handler, {
			path: '/api/github/callback?code=c&installation_id=55&state=other',
			user,
			cookies: { tramline_github_state: 's' }
		});
		expect(forged.status).toBe(403);
	});

	it('sends signed-in users to install the app', async () => {
		seedApp();
		const res = await call(install.GET as Handler, {
			path: '/api/github/install',
			user: seedCtx(db)
		});
		expect(res.location).toBe(
			`https://github.com/apps/tramline-abc/installations/new?state=${res.jar.tramline_github_state}`
		);
		expect((await call(install.GET as Handler, { path: '/api/github/install' })).status).toBe(401);
	});
});
