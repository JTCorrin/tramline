import { context, errorResponse } from '#lib/server/api/handler.js';
import { deployments } from '#lib/server/domain/index.js';
import { followLogs, readLogs } from '#lib/server/nodes/logs.js';
import { settings } from '#lib/server/settings.server.js';
import type { RequestHandler } from './$types';

const HEARTBEAT_MS = 25_000;

/**
 * Server-sent events: the last 1000 log lines, then new lines as they arrive.
 * With `?format=json`, just the last `tail` lines (default 200), e.g. for agents.
 */
export const GET: RequestHandler = (event) => {
	const id = event.params.id;
	try {
		deployments.requireDeployment(context(event), id);
	} catch (error) {
		return errorResponse(error);
	}
	if (event.url.searchParams.get('format') === 'json') {
		const tail = Math.min(1000, Math.max(1, Number(event.url.searchParams.get('tail')) || 200));
		return Response.json(readLogs(settings.dataDir, id).slice(-tail));
	}

	const encoder = new TextEncoder();
	let cleanup = () => {};
	const stream = new ReadableStream({
		start(controller) {
			const send = (text: string) => controller.enqueue(encoder.encode(text));
			for (const line of readLogs(settings.dataDir, id)) send(`data: ${JSON.stringify(line)}\n\n`);
			send('event: ready\ndata: {}\n\n');
			const unfollow = followLogs(id, (line) => send(`data: ${JSON.stringify(line)}\n\n`));
			const heartbeat = setInterval(() => send(': ping\n\n'), HEARTBEAT_MS);
			cleanup = () => {
				clearInterval(heartbeat);
				unfollow();
			};
			event.request.signal.addEventListener('abort', () => {
				cleanup();
				controller.close();
			});
		},
		cancel: () => cleanup()
	});
	return new Response(stream, {
		headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
	});
};
