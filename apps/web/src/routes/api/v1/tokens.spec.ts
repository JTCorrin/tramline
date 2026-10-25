import { db } from '#lib/server/db/index.js';
import { apiToken, auditEvent, member } from '#lib/server/db/schema/index.js';
import * as tokens from '#lib/server/domain/tokens.js';
import { seedCtx } from '#lib/server/testing.js';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as backupStorageRoute from './backup-storage/+server';
import * as auditRoute from './audit-log/+server';
import * as deployRoute from './environments/[id]/deploy/+server';
import * as environmentsRoute from './environments/+server';
import * as projectsRoute from './projects/+server';
import * as tokenRoute from './tokens/[id]/+server';
import * as tokensRoute from './tokens/+server';

/** Calls a handler with a session (a user id) or a bearer token. */
async function call(
	handler: ((event: never) => Response | Promise<Response>) | undefined,
	options: {
		path: string;
		method?: string;
		body?: unknown;
		params?: Record<string, string>;
		session?: { userId: string; organizationId: string };
		bearer?: string;
	}
) {
	const url = new URL(`http://localhost/api/v1${options.path}`);
	const request = new Request(url, {
		method: options.method ?? 'GET',
		headers: {
			'content-type': 'application/json',
			...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {})
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body)
	});
	const locals = options.session
		? {
				user: { id: options.session.userId },
				session: { activeOrganizationId: options.session.organizationId }
			}
		: { user: null, session: null };
	const route = {
		id: `/api/v1${options.path.split('?')[0]!.replace(/env_\w+|prj_\w+|tok_\w+/g, '[id]')}`
	};
	const event = {
		request,
		url,
		params: options.params ?? {},
		locals,
		route
	} as unknown as RequestEvent;
	const response = await handler!(event as never);
	const body = response.headers.get('content-type')?.includes('json')
		? await response.json()
		: null;
	return { status: response.status, body };
}

function setup() {
	const ctx = seedCtx(db);
	const session = { userId: ctx.userId, organizationId: ctx.organizationId };
	return { ctx, session };
}

async function createToken(
	session: { userId: string; organizationId: string },
	scopes: string[],
	expiresInDays: number | null = null
) {
	const res = await call(tokensRoute.POST, {
		path: '/tokens',
		method: 'POST',
		session,
		body: { name: `${scopes.join('+')} token`, scopes, expiresInDays }
	});
	expect(res.status).toBe(201);
	return res.body as { id: string; token: string; prefix: string };
}

describe('API tokens', () => {
	it('are shown once, stored as a hash, and act as their creator', async () => {
		const { ctx, session } = setup();
		const created = await createToken(session, ['read']);
		expect(created.token).toMatch(/^tl_[A-Za-z0-9_-]{43}$/);
		expect(created.token.startsWith(created.prefix)).toBe(true);
		const row = db.select().from(apiToken).where(eq(apiToken.id, created.id)).get()!;
		expect(row.tokenHash).toBe(tokens.hashToken(created.token));
		expect(JSON.stringify(row)).not.toContain(created.token);

		// listing never includes the secret
		const listed = await call(tokensRoute.GET, { path: '/tokens', session });
		expect(listed.body).toEqual([expect.not.objectContaining({ token: expect.anything() })]);

		await call(projectsRoute.POST, {
			path: '/projects',
			method: 'POST',
			session,
			body: { name: 'Shop' }
		});
		const projects = await call(projectsRoute.GET, { path: '/projects', bearer: created.token });
		expect(projects).toMatchObject({ status: 200, body: [{ name: 'Shop' }] });
		expect(
			db.select().from(apiToken).where(eq(apiToken.id, created.id)).get()!.lastUsedAt
		).not.toBeNull();
		void ctx;
	});

	it('are limited to their scopes; deploying needs the deploy scope', async () => {
		const { session } = setup();
		const project = (
			await call(projectsRoute.POST, {
				path: '/projects',
				method: 'POST',
				session,
				body: { name: 'Shop' }
			})
		).body;
		const [env] = (
			await call(environmentsRoute.GET, { path: `/environments?projectId=${project.id}`, session })
		).body;

		const read = await createToken(session, ['read']);
		const write = await createToken(session, ['write']);
		const deploy = await createToken(session, ['deploy']);

		const create = (bearer: string) =>
			call(projectsRoute.POST, {
				path: '/projects',
				method: 'POST',
				bearer,
				body: { name: `p${Math.random()}` }
			});
		expect(await create(read.token)).toMatchObject({
			status: 403,
			body: { error: { message: 'This token needs the write scope' } }
		});
		expect((await create(write.token)).status).toBe(201);

		const deployWith = (bearer: string) =>
			call(deployRoute.POST, {
				path: `/environments/${env.id}/deploy`,
				method: 'POST',
				params: { id: env.id },
				bearer
			});
		expect(await deployWith(write.token)).toMatchObject({
			status: 403,
			body: { error: { message: 'This token needs the deploy scope' } }
		});
		// the deploy scope gets through to the deploy itself (nothing is staged)
		expect(await deployWith(deploy.token)).toMatchObject({
			status: 409,
			body: { error: { message: 'There are no changes to deploy' } }
		});
		// every scope can read
		expect(
			(await call(projectsRoute.GET, { path: '/projects', bearer: deploy.token })).status
		).toBe(200);
	});

	it('cannot manage tokens or organization settings', async () => {
		const { session } = setup();
		const all = await createToken(session, ['read', 'write', 'deploy']);
		const forbidden = {
			status: 403,
			body: { error: { message: 'API tokens cannot do this; sign in to Tramline instead' } }
		};
		expect(
			await call(tokensRoute.POST, {
				path: '/tokens',
				method: 'POST',
				bearer: all.token,
				body: { name: 'more', scopes: ['deploy'], expiresInDays: null }
			})
		).toMatchObject(forbidden);
		expect(
			await call(backupStorageRoute.GET, { path: '/backup-storage', bearer: all.token })
		).toMatchObject(forbidden);
		expect(await call(auditRoute.GET, { path: '/audit-log', bearer: all.token })).toMatchObject(
			forbidden
		);
	});

	it('stop working when revoked, expired, or their creator leaves', async () => {
		const { ctx, session } = setup();
		const unknown = { status: 401, body: { error: { message: 'Unknown or revoked API token' } } };
		expect(await call(projectsRoute.GET, { path: '/projects', bearer: 'tl_nope' })).toMatchObject(
			unknown
		);

		const revoked = await createToken(session, ['read']);
		await call(tokenRoute.DELETE, {
			path: `/tokens/${revoked.id}`,
			method: 'DELETE',
			params: { id: revoked.id },
			session
		});
		expect(
			await call(projectsRoute.GET, { path: '/projects', bearer: revoked.token })
		).toMatchObject(unknown);

		const expiring = await createToken(session, ['read'], 1);
		db.update(apiToken)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(apiToken.id, expiring.id))
			.run();
		expect(
			await call(projectsRoute.GET, { path: '/projects', bearer: expiring.token })
		).toMatchObject({
			status: 401,
			body: { error: { message: 'This token has expired' } }
		});

		const leaver = await createToken(session, ['read']);
		db.delete(member).where(eq(member.userId, ctx.userId)).run();
		expect(
			await call(projectsRoute.GET, { path: '/projects', bearer: leaver.token })
		).toMatchObject(unknown);
	});

	it('are your own to see and revoke, unless you are an owner or admin', async () => {
		const owner = setup();
		const colleague = seedCtx(db);
		// make the colleague a plain member of the owner's organization
		db.insert(member)
			.values({
				id: `mem_x_${colleague.userId}`,
				organizationId: owner.ctx.organizationId,
				userId: colleague.userId,
				role: 'member',
				createdAt: new Date()
			})
			.run();
		const asColleague = { userId: colleague.userId, organizationId: owner.ctx.organizationId };
		const theirs = await createToken(asColleague, ['read']);
		const mine = await createToken(owner.session, ['read']);

		const seen = (await call(tokensRoute.GET, { path: '/tokens', session: asColleague })).body as {
			id: string;
		}[];
		expect(seen.map((t) => t.id)).toEqual([theirs.id]);
		expect(
			(
				await call(tokenRoute.DELETE, {
					path: `/tokens/${mine.id}`,
					method: 'DELETE',
					params: { id: mine.id },
					session: asColleague
				})
			).status
		).toBe(404);
		// the owner sees and can revoke both
		const all = (await call(tokensRoute.GET, { path: '/tokens', session: owner.session })).body as {
			id: string;
		}[];
		expect(all.map((t) => t.id).sort()).toEqual([mine.id, theirs.id].sort());
		expect(
			(
				await call(tokenRoute.DELETE, {
					path: `/tokens/${theirs.id}`,
					method: 'DELETE',
					params: { id: theirs.id },
					session: owner.session
				})
			).status
		).toBe(204);
		expect((await call(auditRoute.GET, { path: '/audit-log', session: asColleague })).status).toBe(
			403
		);
	});
});

describe('audit log', () => {
	it('records every change, by person or token, but not reads', async () => {
		const { ctx, session } = setup();
		const token = await createToken(session, ['write']);
		await call(projectsRoute.POST, {
			path: '/projects',
			method: 'POST',
			bearer: token.token,
			body: { name: 'Via token' }
		});
		await call(projectsRoute.POST, {
			path: '/projects',
			method: 'POST',
			bearer: token.token,
			body: {}
		});
		await call(projectsRoute.GET, { path: '/projects', bearer: token.token });

		const log = (await call(auditRoute.GET, { path: '/audit-log', session })).body as {
			action: string;
			status: number;
			token: { name: string } | null;
			user: { id: string } | null;
		}[];
		expect(log.map((e) => [e.action, e.status, e.token?.name ?? null])).toEqual([
			['POST projects', 422, 'write token'],
			['POST projects', 201, 'write token'],
			['POST tokens', 201, null]
		]);
		expect(log[0]!.user?.id).toBe(ctx.userId);

		// old events are pruned
		db.update(auditEvent)
			.set({ createdAt: new Date(0) })
			.where(eq(auditEvent.organizationId, ctx.organizationId))
			.run();
		tokens.pruneAuditLog(db);
		expect((await call(auditRoute.GET, { path: '/audit-log', session })).body).toEqual([]);
	});

	it('scopes include read', () => {
		expect(tokens.allows(['write'], 'read')).toBe(true);
		expect(tokens.allows(['deploy'], 'read')).toBe(true);
		expect(tokens.allows(['deploy'], 'write')).toBe(false);
		expect(tokens.allows([], 'read')).toBe(false);
	});
});
