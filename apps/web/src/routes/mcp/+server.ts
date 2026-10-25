import { createClient } from '@tramline/client';
import { handleHttpRequest } from '@tramline/mcp';
import type { RequestHandler } from './$types';

/**
 * The Tramline MCP server over Streamable HTTP, for remote agents. Stateless:
 * every request gets a fresh server whose API client carries the caller's
 * token, so an agent can do exactly what that token allows.
 */
const handle: RequestHandler = async (event) => {
	const token = event.request.headers.get('authorization')?.match(/^Bearer\s+(tl_\S+)$/i)?.[1];
	if (!token) {
		return Response.json(
			{
				error: { code: 'unauthenticated', message: 'Send an API token: Authorization: Bearer tl_…' }
			},
			{ status: 401, headers: { 'www-authenticate': 'Bearer' } }
		);
	}
	const client = createClient({ baseUrl: `${event.url.origin}/api/v1`, token, fetch: event.fetch });
	return handleHttpRequest(event.request, client);
};

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
