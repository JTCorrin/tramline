import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Converger, TLS_DIR } from './converge';
import { allowlist, createTcpProxy, postgresError, runTcpProxy } from './tcp-proxy';
import { LABELS } from './runtime';
import { desiredContainer, desiredState, FakeRuntime } from './testing';

const message = (length: number, code: number) => {
	const buffer = Buffer.alloc(8);
	buffer.writeInt32BE(length, 0);
	buffer.writeInt32BE(code, 4);
	return buffer;
};
const SSL_REQUEST = message(8, 80877103);
const GSSENC_REQUEST = message(8, 80877104);
const STARTUP = message(41, 196608);

const servers: net.Server[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.close();
});

const listen = async (server: net.Server) => {
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return (server.address() as net.AddressInfo).port;
};

/** A database that answers SSLRequest with `answer`, then echoes; it records what it got. */
async function fakePostgres(answer = 'S') {
	const received: Buffer[] = [];
	const port = await listen(
		net.createServer((socket) => {
			let first = true;
			socket.on('data', (chunk) => {
				received.push(chunk);
				if (first) {
					first = false;
					socket.write(answer);
				} else socket.write(chunk);
			});
		})
	);
	return { port, received };
}

/** Sends `chunks` in order, collecting everything the proxy sends back until it closes or `until` matches. */
async function talk(port: number, chunks: Buffer[], until?: (all: Buffer) => boolean) {
	return new Promise<{ data: Buffer; closed: boolean }>((resolve) => {
		const socket = net.connect(port, '127.0.0.1');
		let data = Buffer.alloc(0);
		let step = 0;
		const done = (closed: boolean) => {
			socket.destroy();
			resolve({ data, closed });
		};
		socket.on('connect', () => socket.write(chunks[step++]!));
		socket.on('data', (chunk) => {
			data = Buffer.concat([data, chunk]);
			if (until?.(data)) return done(false);
			if (step < chunks.length) socket.write(chunks[step++]!);
		});
		socket.on('close', () => done(true));
		socket.on('error', () => done(true));
	});
}

async function proxy(target: number, allow = ['127.0.0.1']) {
	const logs: string[] = [];
	const port = await listen(
		createTcpProxy(
			{ listen: 0, target: `127.0.0.1:${target}`, allow, protocol: 'postgres' },
			(line) => logs.push(line)
		)
	);
	return { port, logs };
}

describe('allowlist', () => {
	it('matches addresses and blocks, IPv4 and IPv6, including mapped IPv4', () => {
		const allowed = allowlist(['203.0.113.7', '198.51.100.0/24', '2001:db8::/32', 'nonsense']);
		expect(allowed('203.0.113.7')).toBe(true);
		expect(allowed('::ffff:198.51.100.42')).toBe(true);
		expect(allowed('2001:db8::1')).toBe(true);
		expect(allowed('203.0.113.8')).toBe(false);
		expect(allowed('2001:db9::1')).toBe(false);
		expect(allowlist(['0.0.0.0/0'])('192.0.2.1')).toBe(true);
	});
});

describe('TCP proxy', () => {
	it('lets TLS through once the database agrees to it', async () => {
		const db = await fakePostgres();
		const { port } = await proxy(db.port);
		const hello = Buffer.from('client hello');
		const { data } = await talk(port, [SSL_REQUEST, hello], (all) =>
			all.toString().endsWith('client hello')
		);
		expect(data.toString()).toBe('Sclient hello');
		expect(Buffer.concat(db.received).subarray(0, 8)).toEqual(SSL_REQUEST);
	});

	it('declines GSSAPI encryption so the client asks for TLS next', async () => {
		const db = await fakePostgres();
		const { port } = await proxy(db.port);
		const { data } = await talk(port, [GSSENC_REQUEST, SSL_REQUEST], (all) => all.length >= 2);
		expect(data.toString()).toBe('NS');
	});

	it('refuses a plaintext session, saying how to connect', async () => {
		const db = await fakePostgres();
		const { port } = await proxy(db.port);
		const { data, closed } = await talk(port, [STARTUP]);
		expect(closed).toBe(true);
		expect(data.subarray(0, 1).toString()).toBe('E');
		expect(data.toString()).toContain('sslmode=require');
		expect(db.received).toEqual([]);
	});

	it('refuses when the database will not speak TLS', async () => {
		const db = await fakePostgres('N');
		const { port } = await proxy(db.port);
		const { data, closed } = await talk(port, [SSL_REQUEST]);
		expect(closed).toBe(true);
		expect(data).toEqual(postgresError('The database did not offer TLS'));
	});

	it('passes cancel requests, which carry only a secret key', async () => {
		const db = await fakePostgres();
		const { port } = await proxy(db.port);
		const cancel = Buffer.concat([message(16, 80877102), Buffer.from('pidsecret')]).subarray(0, 16);
		await talk(port, [cancel]);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(Buffer.concat(db.received)).toEqual(cancel);
	});

	it('drops connections from outside the allowlist before reading anything', async () => {
		const db = await fakePostgres();
		const { port, logs } = await proxy(db.port, ['10.0.0.0/8']);
		const { data, closed } = await talk(port, [SSL_REQUEST]);
		expect(closed).toBe(true);
		expect(data.length).toBe(0);
		expect(logs[0]).toMatch(/refused .*127\.0\.0\.1: not on the allowlist/);
	});
});

describe('TCP proxy failures', () => {
	it('closes the client when the database is unreachable or the client gives up', async () => {
		const closed = net.createServer();
		const nowhere = await listen(closed);
		closed.close();
		const { port } = await proxy(nowhere);
		expect((await talk(port, [SSL_REQUEST])).closed).toBe(true);
		// half a message, then gone: the proxy closes its side too
		const ended = await new Promise<boolean>((resolve) => {
			const socket = net.connect(port, '127.0.0.1', () => socket.end(SSL_REQUEST.subarray(0, 3)));
			socket.on('close', () => resolve(true));
			socket.on('error', () => resolve(true));
			socket.resume();
		});
		expect(ended).toBe(true);
	});

	it('runs from its config and says what it forwards', async () => {
		const logs: string[] = [];
		const server = await runTcpProxy(
			{ listen: 0, target: '127.0.0.1:5432', allow: ['127.0.0.1'], protocol: 'postgres' },
			(line) => logs.push(line)
		);
		servers.push(server);
		expect(logs[0]).toBe('[proxy] port 0 → 127.0.0.1:5432 (127.0.0.1)');
	});
});

describe('Converger: TLS and TCP proxies', () => {
	const proxyEntry = {
		name: 'tl-tcp-env_1-svc_1',
		port: 30000,
		protocol: 'postgres' as const,
		allow: ['203.0.113.0/24'],
		target: 'dep_1.tramline.internal:5432',
		network: 'tl-env_1'
	};

	function setup(agentImage: string | null = 'tramline-agent:test') {
		const runtime = new FakeRuntime();
		const certificates: string[] = [];
		const converger = new Converger(runtime, {
			nodeId: 'node_1',
			agentImage: agentImage ?? undefined,
			certificates: (id, names) => {
				certificates.push(`${id}:${names.join(',')}`);
				return { cert: 'CERT', key: 'KEY' };
			}
		});
		return { runtime, converger, certificates };
	}

	it('starts a database with TLS on and its key readable by postgres alone', async () => {
		const { runtime, converger, certificates } = setup();
		const pg = desiredContainer({
			image: 'postgres:17',
			tls: { kind: 'postgres', names: ['postgres.production.tramline.internal'] }
		});
		await converger.run(desiredState([pg]));
		const spec = runtime.containers.get(pg.name)!.spec;
		expect(spec.cmd).toEqual([
			'postgres',
			'-c',
			'ssl=on',
			'-c',
			`ssl_cert_file=${TLS_DIR}/server.crt`,
			'-c',
			`ssl_key_file=${TLS_DIR}/server.key`
		]);
		expect(spec.files).toEqual([
			{
				path: `${TLS_DIR}/server.crt`,
				content: Buffer.from('CERT'),
				mode: 0o644,
				uid: 999,
				gid: 999
			},
			{
				path: `${TLS_DIR}/server.key`,
				content: Buffer.from('KEY'),
				mode: 0o600,
				uid: 999,
				gid: 999
			}
		]);
		expect(certificates).toEqual(['env_1-svc_1:postgres.production.tramline.internal']);

		// a start command the user set is left alone
		const custom = desiredContainer({
			name: 'tl-dep_2-0',
			command: 'postgres -c max_connections=50',
			tls: { kind: 'postgres', names: ['pg'] }
		});
		await converger.run(desiredState([pg, custom]));
		expect(runtime.containers.get(custom.name)!.spec.cmd).toEqual([
			'/bin/sh',
			'-c',
			'postgres -c max_connections=50'
		]);
	});

	it('runs one locked-down container per TCP proxy, publishing its edge port', async () => {
		const { runtime, converger } = setup();
		await converger.run({ ...desiredState(), tcpProxies: [proxyEntry] });
		const container = runtime.containers.get('tl-tcp-env_1-svc_1')!;
		expect(container.labels[LABELS.role]).toBe('tcp-proxy');
		expect(container.spec).toMatchObject({
			image: 'tramline-agent:test',
			network: 'tl-env_1',
			ports: [{ container: 30000, host: 30000 }],
			security: { capabilities: [], readOnlyRootFilesystem: true }
		});
		expect(JSON.parse(container.spec.cmd![1]!)).toEqual({
			listen: 30000,
			target: 'dep_1.tramline.internal:5432',
			allow: ['203.0.113.0/24'],
			protocol: 'postgres'
		});

		// a changed allowlist replaces it; a removed proxy is removed
		await converger.run({
			...desiredState(),
			tcpProxies: [{ ...proxyEntry, allow: ['0.0.0.0/0'] }]
		});
		expect(JSON.parse(runtime.containers.get(proxyEntry.name)!.spec.cmd![1]!).allow).toEqual([
			'0.0.0.0/0'
		]);
		await converger.run({ ...desiredState(), tcpProxies: [] });
		expect(runtime.containers.has(proxyEntry.name)).toBe(false);
	});

	it('runs no proxies without the agent image', async () => {
		const { runtime, converger } = setup(null);
		await converger.run({ ...desiredState(), tcpProxies: [proxyEntry] });
		expect(runtime.containers.has(proxyEntry.name)).toBe(false);
	});
});
