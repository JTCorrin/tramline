import { context, errorResponse, param } from '#lib/server/api/handler.js';
import { requireProject } from '#lib/server/domain/access.js';
import { subscribe } from '#lib/server/events.js';
import type { RequestHandler } from './$types';

const HEARTBEAT_MS = 25_000;

/** Server-sent events telling clients which parts of a project changed. */
export const GET: RequestHandler = (event) => {
	let projectId: string;
	try {
		projectId = param(event, 'projectId');
		requireProject(context(event), projectId);
	} catch (error) {
		return errorResponse(error);
	}

	const encoder = new TextEncoder();
	let cleanup = () => {};

	const stream = new ReadableStream({
		start(controller) {
			const send = (text: string) => controller.enqueue(encoder.encode(text));
			send(': connected\n\n');
			const unsubscribe = subscribe(projectId, (data) => send(`data: ${JSON.stringify(data)}\n\n`));
			const heartbeat = setInterval(() => send(': ping\n\n'), HEARTBEAT_MS);
			cleanup = () => {
				clearInterval(heartbeat);
				unsubscribe();
			};
			event.request.signal.addEventListener('abort', () => {
				cleanup();
				controller.close();
			});
		},
		cancel: () => cleanup()
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		}
	});
};
