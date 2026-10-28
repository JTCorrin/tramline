import { AgentJoin } from '@tramline/contracts';
import { body, errorResponse } from '#lib/server/api/handler.js';
import { db } from '#lib/server/db/index.js';
import { join } from '#lib/server/nodes/registry.js';
import type { RequestHandler } from './$types';

/**
 * A new machine's agent trades its one-time join token for a node token.
 * The join token is the only credential, so this route needs no other auth.
 */
export const POST: RequestHandler = async (event) => {
	try {
		const input = await body(event, AgentJoin);
		return Response.json(join(db, input.token, input.hello), { status: 201 });
	} catch (error) {
		return errorResponse(error);
	}
};
