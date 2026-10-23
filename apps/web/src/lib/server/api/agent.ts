import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { db } from '../db';
import { authenticate, type NodeRow } from '../nodes/registry';
import { AppError } from './errors';
import { errorResponse } from './handler';

/** Wraps an `/api/agent/v1` handler: authenticates the node by its bearer token. */
export function agentEndpoint(fn: (node: NodeRow, event: RequestEvent) => unknown): RequestHandler {
	return async (event) => {
		try {
			const token = event.request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
			const node = authenticate(db, token);
			if (!node) throw new AppError('unauthenticated', 'Unknown agent token');
			const result = await fn(node, event);
			if (result instanceof Response) return result;
			if (result === undefined) return new Response(null, { status: 204 });
			return Response.json(result);
		} catch (error) {
			return errorResponse(error);
		}
	};
}
