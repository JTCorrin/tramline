import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { TRAMLINE_SECRET_KEY } from '$app/env/private';
import { createSecrets } from '../crypto';
import { db, schema } from '../db';
import { settings } from '../settings.server';
import type { Ctx } from '../domain';
import { AppError, validationFailed } from './errors';

export const secrets = createSecrets(TRAMLINE_SECRET_KEY);

/**
 * Wraps an `/api/v1` handler: authenticates the caller, builds the domain
 * context, serialises the result as JSON and maps errors to the envelope.
 * Return `undefined` for a 204.
 */
export function endpoint(fn: (ctx: Ctx, event: RequestEvent) => unknown): RequestHandler {
	return async (event) => {
		try {
			const result = await fn(context(event), event);
			if (result instanceof Response) return result;
			if (result === undefined) return new Response(null, { status: 204 });
			return Response.json(result, { status: event.request.method === 'POST' ? 201 : 200 });
		} catch (error) {
			return errorResponse(error);
		}
	};
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
