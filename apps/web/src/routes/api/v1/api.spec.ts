import { db } from '#lib/server/db/index.js';
import { endpoint } from '#lib/server/api/handler.js';
import { publish } from '#lib/server/events.js';
import { seedCtx } from '#lib/server/testing.js';
import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import * as fallback from './[...rest]/+server';
import * as deploymentsRoute from './deployments/+server';
import * as environmentRoute from './environments/[id]/+server';
import * as canvasRoute from './environments/[id]/canvas/+server';
import * as changesRoute from './environments/[id]/changes/+server';
import * as deployRoute from './environments/[id]/deploy/+server';
import * as environmentsRoute from './environments/+server';
import * as eventsRoute from './events/+server';
import * as projectRoute from './projects/[id]/+server';
import * as projectsRoute from './projects/+server';
import * as configRoute from './services/[id]/config/+server';
import * as serviceRoute from './services/[id]/+server';
import * as servicesRoute from './services/+server';
import * as variablesRoute from './variables/+server';

type Auth = { userId: string; organizationId: string | null } | null;

/** Calls a `+server.ts` handler the way SvelteKit would, as the given user. */
async function call(
	// any route's handler; each is typed for its own route
	handler: ((event: never) => Response | Promise<Response>) | undefined,
	options: {
		path: string;
		method?: string;
		body?: unknown;
		params?: Record<string, string>;
		auth: Auth;
	}
) {
	const url = new URL(`http://localhost/api/v1${options.path}`);
	const raw = options.body;
	const request = new Request(url, {
		method: options.method ?? 'GET',
		headers: { 'content-type': 'application/json' },
		body: raw === undefined ? undefined : typeof raw === 'string' ? raw : JSON.stringify(raw)
	});
	const locals = options.auth
		? {
				user: { id: options.auth.userId },
				session: { activeOrganizationId: options.auth.organizationId }
			}
		: { user: null, session: null };
	const event = { request, url, params: options.params ?? {}, locals } as unknown as RequestEvent;
	const response = await handler!(event as never);
	const text = response.headers.get('content-type')?.includes('json')
		? await response.json()
		: null;
	return { status: response.status, body: text, response };
}

const user = () => seedCtx(db);

describe('authentication and authorization', () => {
	it('rejects anonymous callers', async () => {
		const res = await call(projectsRoute.GET, { path: '/projects', auth: null });
		expect(res).toMatchObject({ status: 401, body: { error: { code: 'unauthenticated' } } });
	});

	it('requires an active organization', async () => {
		const { userId } = user();
		const res = await call(projectsRoute.GET, {
			path: '/projects',
			auth: { userId, organizationId: null }
		});
		expect(res).toMatchObject({
			status: 403,
			body: { error: { message: 'Select an organization first' } }
		});
	});

	it('rejects organizations the caller is not a member of', async () => {
		const alice = user();
		const bob = user();
		const res = await call(projectsRoute.GET, {
			path: '/projects',
			auth: { userId: bob.userId, organizationId: alice.organizationId }
		});
		expect(res.status).toBe(403);
	});
});

describe('projects API', () => {
	it('creates, validates, reads, updates and deletes', async () => {
		const auth = user();
		const created = await call(projectsRoute.POST, {
			path: '/projects',
			method: 'POST',
			body: { name: 'Shop' },
			auth
		});
		expect(created).toMatchObject({ status: 201, body: { name: 'Shop' } });
		const id = created.body.id;

		expect(
			(
				await call(projectsRoute.POST, {
					path: '/projects',
					method: 'POST',
					body: { name: '' },
					auth
				})
			).body
		).toEqual({
			error: {
				code: 'validation_failed',
				message: 'Name is required',
				issues: [{ path: 'name', message: 'Name is required' }]
			}
		});
		expect(
			(await call(projectsRoute.POST, { path: '/projects', method: 'POST', body: '{oops', auth }))
				.status
		).toBe(400);

		expect(
			(await call(projectRoute.GET, { path: `/projects/${id}`, params: { id }, auth })).body.name
		).toBe('Shop');
		expect(
			(
				await call(projectRoute.PATCH, {
					path: `/projects/${id}`,
					method: 'PATCH',
					params: { id },
					body: { name: 'Store' },
					auth
				})
			).body.name
		).toBe('Store');
		expect(
			(await call(projectRoute.GET, { path: `/projects/${id}`, params: { id }, auth: user() }))
				.status
		).toBe(404);
		expect(
			(
				await call(projectRoute.DELETE, {
					path: `/projects/${id}`,
					method: 'DELETE',
					params: { id },
					auth
				})
			).status
		).toBe(204);
		expect((await call(projectsRoute.GET, { path: '/projects', auth })).body).toEqual([]);
	});
});

describe('canvas workflow API', () => {
	it('adds services, stages variables, deploys and discards', async () => {
		const auth = user();
		const project = (
			await call(projectsRoute.POST, {
				path: '/projects',
				method: 'POST',
				body: { name: 'App' },
				auth
			})
		).body;
		const [env] = (
			await call(environmentsRoute.GET, { path: `/environments?projectId=${project.id}`, auth })
		).body;
		expect(env.name).toBe('production');

		const pg = (
			await call(servicesRoute.POST, {
				path: '/services',
				method: 'POST',
				auth,
				body: {
					projectId: project.id,
					kind: 'database',
					engine: 'postgres',
					position: { x: 0, y: 0 }
				}
			})
		).body;
		const api = (
			await call(servicesRoute.POST, {
				path: '/services',
				method: 'POST',
				auth,
				body: {
					projectId: project.id,
					kind: 'image',
					source: { type: 'image', image: 'traefik/whoami' }
				}
			})
		).body;
		expect(
			(await call(servicesRoute.GET, { path: `/services?projectId=${project.id}`, auth })).body
		).toHaveLength(2);

		const vars = await call(variablesRoute.PATCH, {
			path: '/variables',
			method: 'PATCH',
			auth,
			body: {
				environmentId: env.id,
				serviceId: api.id,
				set: { DATABASE_URL: '${{Postgres.DATABASE_URL}}' }
			}
		});
		expect(vars.body).toEqual([
			{ key: 'DATABASE_URL', value: '${{Postgres.DATABASE_URL}}', sealed: false, staged: 'added' }
		]);
		expect(
			(
				await call(variablesRoute.GET, {
					path: `/variables?environmentId=${env.id}&serviceId=${api.id}`,
					auth
				})
			).body
		).toHaveLength(1);

		const canvas = (
			await call(canvasRoute.GET, {
				path: `/environments/${env.id}/canvas`,
				params: { id: env.id },
				auth
			})
		).body;
		expect(canvas.edges).toEqual([{ id: `${pg.id}->${api.id}`, source: pg.id, target: api.id }]);
		expect(
			(
				await call(changesRoute.GET, {
					path: `/environments/${env.id}/changes`,
					params: { id: env.id },
					auth
				})
			).body.count
		).toBe(2);

		const deployed = await call(deployRoute.POST, {
			path: `/environments/${env.id}/deploy`,
			method: 'POST',
			params: { id: env.id },
			auth
		});
		expect(deployed.status).toBe(201);
		expect(deployed.body.map((d: { status: string }) => d.status)).toEqual(['queued', 'queued']);
		expect(
			(
				await call(deploymentsRoute.GET, {
					path: `/deployments?serviceId=${api.id}&environmentId=${env.id}`,
					auth
				})
			).body
		).toHaveLength(1);

		const config = await call(configRoute.PATCH, {
			path: `/services/${api.id}/config?environmentId=${env.id}`,
			method: 'PATCH',
			params: { id: api.id },
			auth,
			body: { deploy: { replicas: 2 } }
		});
		expect(config.body).toMatchObject({
			staged: true,
			applied: { deploy: { replicas: 1 } },
			effective: { deploy: { replicas: 2 } }
		});
		expect(
			(
				await call(configRoute.GET, {
					path: `/services/${api.id}/config?environmentId=${env.id}`,
					params: { id: api.id },
					auth
				})
			).body.staged
		).toBe(true);

		expect(
			(
				await call(changesRoute.DELETE, {
					path: `/environments/${env.id}/changes`,
					method: 'DELETE',
					params: { id: env.id },
					auth
				})
			).status
		).toBe(204);
		expect(
			(
				await call(changesRoute.GET, {
					path: `/environments/${env.id}/changes`,
					params: { id: env.id },
					auth
				})
			).body.count
		).toBe(0);

		const renamed = await call(serviceRoute.PATCH, {
			path: `/services/${api.id}`,
			method: 'PATCH',
			params: { id: api.id },
			body: { name: 'web', position: { x: 10, y: 20 } },
			auth
		});
		expect(renamed.body).toMatchObject({ name: 'web', position: { x: 10, y: 20 } });
		const clash = await call(serviceRoute.PATCH, {
			path: `/services/${api.id}`,
			method: 'PATCH',
			params: { id: api.id },
			body: { name: 'postgres' },
			auth
		});
		expect(clash).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } });
		expect(
			(await call(serviceRoute.GET, { path: `/services/${api.id}`, params: { id: api.id }, auth }))
				.body.name
		).toBe('web');
		expect(
			(
				await call(serviceRoute.DELETE, {
					path: `/services/${api.id}`,
					method: 'DELETE',
					params: { id: api.id },
					auth
				})
			).status
		).toBe(204);
	});

	it('manages environments', async () => {
		const auth = user();
		const project = (
			await call(projectsRoute.POST, {
				path: '/projects',
				method: 'POST',
				body: { name: 'Envs' },
				auth
			})
		).body;
		const staging = await call(environmentsRoute.POST, {
			path: '/environments',
			method: 'POST',
			body: { projectId: project.id, name: 'Staging ' },
			auth
		});
		expect(staging.body.name).toBe('staging');
		const id = staging.body.id;
		expect(
			(
				await call(environmentsRoute.POST, {
					path: '/environments',
					method: 'POST',
					body: { projectId: project.id, name: 'bad name' },
					auth
				})
			).status
		).toBe(422);
		expect(
			(
				await call(environmentRoute.PATCH, {
					path: `/environments/${id}`,
					method: 'PATCH',
					params: { id },
					body: { name: 'qa' },
					auth
				})
			).body.name
		).toBe('qa');
		expect(
			(await call(environmentRoute.GET, { path: `/environments/${id}`, params: { id }, auth })).body
				.name
		).toBe('qa');
		expect(
			(
				await call(environmentRoute.DELETE, {
					path: `/environments/${id}`,
					method: 'DELETE',
					params: { id },
					auth
				})
			).status
		).toBe(204);
	});

	it('requires query parameters', async () => {
		const res = await call(servicesRoute.GET, { path: '/services', auth: user() });
		expect(res).toMatchObject({
			status: 400,
			body: { error: { message: 'Missing ?projectId= query parameter' } }
		});
	});
});

describe('errors', () => {
	it('returns the envelope for unknown endpoints', async () => {
		const res = await call(fallback.fallback, { path: '/nope', auth: null });
		expect(res).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
	});

	it('hides unexpected errors behind a generic 500', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const handler = endpoint(() => {
			throw new Error('database exploded');
		});
		const res = await call(handler, { path: '/x', auth: user() });
		expect(res).toMatchObject({
			status: 500,
			body: { error: { code: 'internal', message: 'Something went wrong' } }
		});
		expect(log).toHaveBeenCalled();
		log.mockRestore();
	});
});

describe('events stream', () => {
	it('streams project events to members only', async () => {
		const auth = user();
		const project = (
			await call(projectsRoute.POST, {
				path: '/projects',
				method: 'POST',
				body: { name: 'Live' },
				auth
			})
		).body;

		expect(
			(await call(eventsRoute.GET, { path: `/events?projectId=${project.id}`, auth: user() }))
				.status
		).toBe(404);

		const { response } = await call(eventsRoute.GET, {
			path: `/events?projectId=${project.id}`,
			auth
		});
		expect(response.headers.get('content-type')).toBe('text/event-stream');
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		expect(decoder.decode((await reader.read()).value)).toBe(': connected\n\n');

		publish({ type: 'services', projectId: project.id });
		expect(decoder.decode((await reader.read()).value)).toBe(
			`data: ${JSON.stringify({ type: 'services', projectId: project.id })}\n\n`
		);
		await reader.cancel();
	});
});
