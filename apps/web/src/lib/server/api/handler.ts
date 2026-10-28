import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { TokenScope } from '@tramline/contracts';
import type { z } from 'zod';
import { TRAMLINE_SECRET_KEY } from '$app/env/private';
import { createSecrets } from '../crypto';
import { db, schema } from '../db';
import { settings } from '../settings.server';
import type { Ctx } from '../domain';
import { allows, authenticate, record } from '../domain/tokens';
import { AppError, validationFailed } from './errors';

export const secrets = createSecrets(TRAMLINE_SECRET_KEY);

export interface EndpointOptions {
	/**
	 * What an API token needs: `read` for GETs and `write` for other methods
	 * unless set. `deploy` marks endpoints that apply changes.
	 */
	scope?: TokenScope;
	/** Only a signed-in person may call it, never a token (e.g. creating tokens). */
	session?: boolean;
}

/**
 * Wraps an `/api/v1` handler: authenticates the caller (a session or an API
 * token), checks the token's scopes, builds the domain context, serialises
 * the result as JSON, maps errors to the envelope, and records every change
 * in the audit log. Return `undefined` for a 204.
 */
export function endpoint(
	fn: (ctx: Ctx, event: RequestEvent) => unknown,
	options: EndpointOptions = {}
): RequestHandler {
	return async (event) => {
		let ctx: Ctx | undefined;
		let response: Response;
		try {
			ctx = context(event);
			authorize(ctx, event, options);
			const result = await fn(ctx, event);
			response =
				result instanceof Response
					? result
					: result === undefined
						? new Response(null, { status: 204 })
						: Response.json(result, { status: event.request.method === 'POST' ? 201 : 200 });
		} catch (error) {
			response = errorResponse(error);
		}
		if (ctx && event.request.method !== 'GET') audit(ctx, event, response.status);
		return response;
	};
}

function authorize(ctx: Ctx, event: RequestEvent, options: EndpointOptions) {
	if (!ctx.token) return;
	if (options.session) {
		throw new AppError('forbidden', 'API tokens cannot do this; sign in to Tramline instead');
	}
	// deleting takes down what is running (services, projects, environments, domains, backups),
	// so it needs the scope that applies changes, not the one that stages them
	const scope =
		options.scope ??
		(event.request.method === 'GET'
			? 'read'
			: event.request.method === 'DELETE'
				? 'deploy'
				: 'write');
	if (!allows(ctx.token.scopes, scope)) {
		throw new AppError('forbidden', `This token needs the ${scope} scope`);
	}
}

/** e.g. `POST environments/[id]/deploy`, with the route's parameters. */
function audit(ctx: Ctx, event: RequestEvent, status: number) {
	const route = (event.route?.id ?? event.url.pathname).replace(/^\/api\/v1\//, '');
	try {
		record(db, ctx, {
			action: `${event.request.method} ${route}`,
			params: { ...event.params } as Record<string, string>,
			status
		});
	} catch (error) {
		console.error('[audit]', error);
	}
}

/** Parses and validates a JSON request body against a contract schema. */
export async function body<S extends z.ZodType>(
	event: RequestEvent,
	schema: S
): Promise<z.infer<S>> {
	const json = await event.request.json().catch(() => {
		throw new AppError('bad_request', 'Request body must be valid JSON');
	});
	const parsed = schema.safeParse(json);
	if (!parsed.success) throw validationFailed(parsed.error);
	return parsed.data;
}

export function errorResponse(error: unknown) {
	if (error instanceof AppError) return Response.json(error.toBody(), { status: error.status });
	console.error(error);
	const internal = new AppError('internal', 'Something went wrong');
	return Response.json(internal.toBody(), { status: internal.status });
}

/** Reads a required query string parameter. */
export function param(event: RequestEvent, name: string) {
	const value = event.url.searchParams.get(name);
	if (!value) throw new AppError('bad_request', `Missing ?${name}= query parameter`);
	return value;
}

export function context(event: RequestEvent): Ctx {
	const bearer = event.request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
	if (bearer) {
		const token = authenticate(db, bearer.trim());
		if (!token) throw new AppError('unauthenticated', 'Unknown or revoked API token');
		return {
			db,
			secrets,
			settings,
			userId: token.userId,
			organizationId: token.organizationId,
			token: { id: token.id, name: token.name, scopes: token.scopes }
		};
	}

	const { user, session } = event.locals;
	if (!user || !session) throw new AppError('unauthenticated', 'You need to sign in');

	const organizationId = session.activeOrganizationId;
	if (!organizationId) throw new AppError('forbidden', 'Select an organization first');

	const membership = db
		.select({ id: schema.member.id })
		.from(schema.member)
		.where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, user.id)))
		.get();
	if (!membership) throw new AppError('forbidden', 'You are not a member of this organization');

	return { db, secrets, settings, userId: user.id, organizationId };
}
