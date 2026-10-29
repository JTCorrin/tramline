// Starts the production build: `pnpm start`.
//
// adapter-node takes each request's protocol from PROTOCOL_HEADER, and assumes https without one.
// Tramline knows its own URL, so unless a proxy is trusted to say (PROTOCOL_HEADER is set), the
// protocol comes from TRAMLINE_URL. Without this, an install on plain HTTP (a LAN, say) fails
// every sign-in and form post, because each request looks like it came from https://.
import http from 'node:http';
import process from 'node:process';

const HEADER = 'x-tramline-protocol';
const own =
	process.env.TRAMLINE_URL && !process.env.PROTOCOL_HEADER
		? new URL(process.env.TRAMLINE_URL).protocol.replace(/:$/, '')
		: null;
if (own) process.env.PROTOCOL_HEADER = HEADER;

const { handler } = await import('./build/handler.js');

const server = http.createServer((req, res) => {
	// set, never passed through: the client doesn't get to choose
	if (own) req.headers[HEADER] = own;
	handler(req, res, () => {
		res.statusCode = 404;
		res.end();
	});
});

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
server.listen(port, host, () => console.log(`Listening on http://${host}:${port}`));

function shutdown(reason) {
	server.close(() => {
		process.emit('sveltekit:shutdown', reason);
		process.exit(0);
	});
	server.closeIdleConnections();
	setTimeout(() => server.closeAllConnections(), 30_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
