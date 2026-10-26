import { BlockList, isIPv4, isIPv6 } from 'node:net';
import net from 'node:net';

/**
 * A database's public TCP port on an edge node (`agent.mjs proxy <config>`).
 * Connections from outside the allowlist are closed at once. For Postgres,
 * TLS has to be negotiated with the database itself before anything else
 * crosses: the client's first message must be an SSLRequest, and the
 * database must answer it with 'S'. Passwords and queries never cross in
 * the clear, and the proxy never holds a key: TLS ends in the database.
 */

export interface ProxyConfig {
	listen: number;
	/** `host:port` */
	target: string;
	allow: string[];
	protocol: 'postgres';
}

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;

/** Builds the allowlist; `0.0.0.0/0` and `::/0` let everyone in. */
export function allowlist(entries: string[]) {
	const list = new BlockList();
	for (const entry of entries) {
		const [address, bits] = entry.split('/');
		const type = isIPv6(address!) ? 'ipv6' : 'ipv4';
		if (!isIPv4(address!) && !isIPv6(address!)) continue;
		if (bits === undefined) list.addAddress(address!, type);
		else list.addSubnet(address!, Number(bits), type);
	}
	return (address: string) => {
		// IPv4 clients of a dual-stack socket arrive as ::ffff:a.b.c.d
		const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
		return isIPv4(v4) ? list.check(v4, 'ipv4') : list.check(address, 'ipv6');
	};
}

/** A Postgres ErrorResponse, which libpq shows as the reason the connection failed. */
export function postgresError(message: string) {
	const fields = Buffer.concat([
		Buffer.from('SFATAL\0'),
		Buffer.from('C08P01\0'),
		Buffer.from(`M${message}\0`),
		Buffer.from([0])
	]);
	const header = Buffer.alloc(5);
	header.write('E', 0);
	header.writeInt32BE(fields.length + 4, 1);
	return Buffer.concat([header, fields]);
}

const readExactly = (socket: net.Socket, length: number) =>
	new Promise<Buffer | null>((resolve) => {
		let buffered = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			if (buffered.length < length) return;
			cleanup();
			if (buffered.length > length) socket.unshift(buffered.subarray(length));
			resolve(buffered.subarray(0, length));
		};
		const onEnd = () => {
			cleanup();
			resolve(null);
		};
		const cleanup = () => {
			socket.off('data', onData);
			socket.off('end', onEnd);
			socket.off('error', onEnd);
			socket.pause();
		};
		socket.on('data', onData);
		socket.on('end', onEnd);
		socket.on('error', onEnd);
		socket.resume();
	});

/**
 * Lets a Postgres client through only once TLS is on its way: answers a
 * GSSAPI encryption request with 'N' (clients then ask for TLS), passes
 * cancel requests (they carry a secret key and nothing else), and refuses
 * a plain startup message.
 */
async function postgresHandshake(client: net.Socket, connect: () => net.Socket) {
	for (;;) {
		const head = await readExactly(client, 8);
		if (!head) return client.destroy();
		const length = head.readInt32BE(0);
		const code = head.readInt32BE(4);
		if (length === 8 && code === GSSENC_REQUEST) {
			client.write('N');
			continue;
		}
		if (length === 16 && code === CANCEL_REQUEST) {
			const rest = await readExactly(client, 8);
			if (!rest) return client.destroy();
			const upstream = connect();
			upstream.on('error', () => client.destroy());
			upstream.end(Buffer.concat([head, rest]));
			return client.end();
		}
		if (length !== 8 || code !== SSL_REQUEST) {
			client.end(
				postgresError(
					'Tramline only accepts TLS here. Connect with sslmode=require (or verify-full).'
				)
			);
			return;
		}
		const upstream = connect();
		upstream.on('error', () => client.destroy());
		upstream.write(head);
		const answer = await readExactly(upstream, 1);
		// the database must agree to TLS; a plaintext session never starts
		if (!answer || answer[0] !== 0x53) {
			upstream.destroy();
			return client.end(postgresError('The database did not offer TLS'));
		}
		client.write(answer);
		client.pipe(upstream).pipe(client);
		client.resume();
		upstream.resume();
		return;
	}
}

export function createTcpProxy(config: ProxyConfig, log: (line: string) => void = console.log) {
	const allowed = allowlist(config.allow);
	const separator = config.target.lastIndexOf(':');
	const host = config.target.slice(0, separator);
	const port = Number(config.target.slice(separator + 1));
	return net.createServer({ pauseOnConnect: true }, (client) => {
		const address = client.remoteAddress ?? '';
		if (!allowed(address)) {
			log(`[proxy] refused ${address}: not on the allowlist`);
			return client.destroy();
		}
		client.on('error', () => client.destroy());
		void postgresHandshake(client, () => {
			const upstream = net.connect(port, host);
			upstream.on('close', () => client.destroy());
			client.on('close', () => upstream.destroy());
			return upstream;
		});
	});
}

export async function runTcpProxy(config: ProxyConfig, log: (line: string) => void = console.log) {
	const server = createTcpProxy(config, log);
	await new Promise<void>((resolve) => server.listen(config.listen, resolve));
	log(`[proxy] port ${config.listen} → ${config.target} (${config.allow.join(', ')})`);
	return server;
}
