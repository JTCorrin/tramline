import type { AccessEntry } from '@tramline/contracts';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
	AccessShipper,
	MAX_QUEUED_ENTRIES,
	UNSUPPORTED_RETRY_MS,
	clientAddress,
	parseCaddyLine,
	parseProxyLine,
	type ClientContext
} from './access';
import { caddyConfig } from './caddy';
import { ControlPlaneError } from './client';
import { LABELS, type ManagedContainer } from './runtime';
import { accessLine, allowlist, createTcpProxy } from './tcp-proxy';
import { FakeRuntime } from './testing';

const context = (trusted: string[] = [], gateways: string[] = []): ClientContext => ({
	gateways: new Set(gateways),
	trusted: allowlist(trusted)
});

/** A line as Caddy writes it, per https://caddyserver.com/docs/logging. */
const caddy = (overrides: Record<string, unknown> = {}, request: Record<string, unknown> = {}) =>
	JSON.stringify({
		level: 'info',
		ts: 1_800_000_000.25,
		logger: 'http.log.access.ingress',
		msg: 'handled request',
		request: {
			remote_ip: '203.0.113.9',
			remote_port: '51234',
			client_ip: '203.0.113.9',
			proto: 'HTTP/1.1',
			method: 'GET',
			host: 'App.Example.com:443',
			uri: '/.env?x=1',
			headers: { 'User-Agent': ['zgrab/0.x'], Authorization: ['REDACTED'] },
			...request
		},
		bytes_read: 0,
		user_id: '',
		duration: 0.0042,
		size: 49,
		status: 404,
		resp_headers: {},
		...overrides
	});

describe('reading Caddy access logs', () => {
	it('turns a request into an entry', () => {
		expect(parseCaddyLine(caddy(), context())).toEqual({
			kind: 'http',
			ts: new Date(1_800_000_000_250).toISOString(),
			host: 'app.example.com',
			method: 'GET',
			path: '/.env?x=1',
			status: 404,
			durationMs: 4.2,
			bytes: 49,
			client: '203.0.113.9',
			userAgent: 'zgrab/0.x',
			tunnel: false
		});
	});

	it("ignores Caddy's own messages and anything that isn't JSON", () => {
		expect(parseCaddyLine('not json', context())).toBeNull();
		expect(parseCaddyLine(caddy({ logger: 'tls.obtain' }), context())).toBeNull();
		expect(parseCaddyLine(caddy({}, { remote_ip: 'nonsense' }), context())).toBeNull();
	});

	it('cuts long paths and user agents, and copes with missing fields', () => {
		const entry = parseCaddyLine(
			caddy(
				{ ts: 'garbage', duration: 'soon', size: -5, status: 5000 },
				{ uri: '/' + 'a'.repeat(5000), headers: { 'user-agent': 'x'.repeat(1000) } }
			),
			context()
		);
		expect(entry).toMatchObject({ durationMs: 0, bytes: 0, status: 999 });
		if (entry?.kind !== 'http') throw new Error('expected http');
		expect(entry.path.length).toBeLessThanOrEqual(1025);
		expect(entry.userAgent!.length).toBeLessThanOrEqual(257);
		expect(Date.parse(entry.ts)).not.toBeNaN();
		expect(parseCaddyLine(caddy({}, { headers: undefined }), context())).toMatchObject({
			userAgent: null
		});
	});

	it('marks requests the tunnel server handled', () => {
		expect(parseCaddyLine(caddy({ logger: 'http.log.access.tunnel' }), context())).toMatchObject({
			tunnel: true
		});
	});
});

describe('who sent a request', () => {
	const tunnelled = { 'Cf-Connecting-Ip': ['198.51.100.7'] };

	it("believes Cloudflare's header only from the host, on the tunnel server", () => {
		const ctx = context([], ['172.18.0.1']);
		expect(clientAddress('172.18.0.1', tunnelled, true, ctx)).toBe('198.51.100.7');
		expect(clientAddress('127.0.0.1', tunnelled, true, ctx)).toBe('198.51.100.7');
		// a service container on the same network setting the header itself
		expect(clientAddress('172.18.0.5', tunnelled, true, ctx)).toBe('172.18.0.5');
		// the public server never takes it
		expect(clientAddress('172.18.0.1', tunnelled, false, ctx)).toBe('172.18.0.1');
		expect(clientAddress('172.18.0.1', { 'cf-connecting-ip': 'junk' }, true, ctx)).toBe(
			'172.18.0.1'
		);
	});

	it('reads X-Forwarded-For from the right, only through trusted proxies', () => {
		const ctx = context(['10.0.0.0/8']);
		const xff = (value: string | string[]) => ({ 'X-Forwarded-For': value });
		// the client wrote a fake first hop; the proxy appended the real address
		expect(clientAddress('10.0.0.2', xff('6.6.6.6, 198.51.100.7'), false, ctx)).toBe(
			'198.51.100.7'
		);
		// two of our proxies in a row
		expect(clientAddress('10.0.0.2', xff(['198.51.100.7, 10.0.0.3']), false, ctx)).toBe(
			'198.51.100.7'
		);
		// from anyone else, the header is ignored
		expect(clientAddress('203.0.113.9', xff('198.51.100.7'), false, ctx)).toBe('203.0.113.9');
		// a broken hop stops the walk
		expect(clientAddress('10.0.0.2', xff('198.51.100.7, nope'), false, ctx)).toBe('10.0.0.2');
		expect(clientAddress('::ffff:10.0.0.2', {}, false, ctx)).toBe('10.0.0.2');
	});
});

describe('reading the TCP proxy', () => {
	it('turns a connection line into an entry and ignores the rest', () => {
		const line = accessLine({
			port: 15432,
			client: '::ffff:203.0.113.9',
			outcome: 'refused',
			durationMs: 1,
			bytesIn: 0,
			bytesOut: 0,
			ts: '2027-01-15T08:00:00.000Z'
		});
		expect(parseProxyLine(line)).toEqual({
			kind: 'tcp',
			ts: '2027-01-15T08:00:00.000Z',
			port: 15432,
			client: '203.0.113.9',
			outcome: 'refused',
			durationMs: 1,
			bytesIn: 0,
			bytesOut: 0
		});
		expect(parseProxyLine('[proxy] port 15432 → db:5432')).toBeNull();
		expect(parseProxyLine('{nope')).toBeNull();
		expect(parseProxyLine('{"access":"http"}')).toBeNull();
		expect(parseProxyLine(line.replace('refused', 'sideways'))).toBeNull();
		expect(parseProxyLine(line.replace('15432', '0'))).toBeNull();
	});

	const connect = (port: number) =>
		new Promise<net.Socket>((resolve) => {
			const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
		});
	const closed = (socket: net.Socket) => new Promise((resolve) => socket.on('close', resolve));

	it('logs each connection with how it ended', async () => {
		const lines: string[] = [];
		const listen = (allow: string[]) =>
			new Promise<net.Server>((resolve) => {
				const server = createTcpProxy(
					{ listen: 15432, target: '127.0.0.1:1', allow, protocol: 'postgres' },
					(line) => lines.push(line)
				);
				server.listen(0, '127.0.0.1', () => resolve(server));
			});
		const open = await listen(['0.0.0.0/0']);
		const shut = await listen([]);
		const port = (s: net.Server) => (s.address() as net.AddressInfo).port;

		// a plain startup message: refused, after it was read
		const plain = await connect(port(open));
		const startup = Buffer.alloc(8);
		startup.writeInt32BE(8, 0);
		startup.writeInt32BE(196608, 4);
		plain.write(startup);
		plain.resume();
		await closed(plain);
		// not on the allowlist
		await closed(await connect(port(shut)));
		// a port check that sends nothing isn't logged
		const idle = await connect(port(open));
		idle.end();
		await closed(idle);
		await new Promise((r) => setTimeout(r, 20));

		const entries = lines.map(parseProxyLine).filter(Boolean) as AccessEntry[];
		expect(entries.map((e) => e.kind === 'tcp' && e.outcome).sort()).toEqual([
			'plaintext',
			'refused'
		]);
		expect(entries.find((e) => e.kind === 'tcp' && e.outcome === 'plaintext')).toMatchObject({
			bytesIn: 8,
			client: '127.0.0.1'
		});
		open.close();
		shut.close();
	});
});

describe('the ingress logs its requests', () => {
	it('sends access logs to stdout and names the tunnel server', () => {
		const config = caddyConfig({
			httpPort: 80,
			tls: false,
			routes: [],
			tunnel: { port: 8090, routes: [] }
		}) as unknown as {
			logging: { logs: Record<string, { include?: string[]; exclude?: string[] }> };
			apps: { http: { servers: Record<string, { logs: { default_logger_name: string } }> } };
		};
		expect(config.logging.logs.access!.include).toEqual(['http.log.access']);
		expect(config.logging.logs.default!.exclude).toEqual(['http.log.access']);
		expect(config.apps.http.servers.tramline!.logs.default_logger_name).toBe('ingress');
		expect(config.apps.http.servers.tunnel!.logs.default_logger_name).toBe('tunnel');
	});
});

const container = (
	name: string,
	role: string,
	overrides: Partial<ManagedContainer> = {}
): ManagedContainer => ({
	name,
	labels: { [LABELS.managed]: 'true', [LABELS.role]: role },
	networks: ['tl-env_1'],
	status: 'running',
	exitCode: null,
	restartCount: 0,
	startedAt: null,
	...overrides
});

describe('AccessShipper', () => {
	const setup = (
		send = vi.fn(async (_entries: AccessEntry[]) => {}),
		now = () => 1_800_000_000_000
	) => {
		const runtime = new FakeRuntime();
		runtime.networks.add('tl-env_1');
		const shipper = new AccessShipper(runtime, send, { now, maxBatch: 2, maxQueued: 3 });
		return { runtime, shipper, send };
	};

	it('follows the ingress and TCP proxies only, from when the agent started', async () => {
		const { runtime, shipper, send } = setup();
		await shipper.sync([
			container('tramline-ingress-n', 'ingress'),
			container('tl-tcp-env_1-svc_1', 'tcp-proxy'),
			container('tl-dep_1-0', 'workload'),
			container('tramline-ingress-old', 'ingress', { status: 'exited' })
		]);
		expect([...runtime.followers.keys()].sort()).toEqual([
			'tl-tcp-env_1-svc_1',
			'tramline-ingress-n'
		]);
		expect(runtime.followers.get('tramline-ingress-n')!.since).toBe(1_800_000_000 - 5);

		const ingress = runtime.followers.get('tramline-ingress-n')!.onLine;
		// the tunnel server's request from the host's address on the ingress's network
		ingress(
			'stdout',
			'2027-01-15T08:00:00.000000001Z',
			caddy(
				{ logger: 'http.log.access.tunnel' },
				{ remote_ip: '172.18.0.1', headers: { 'Cf-Connecting-Ip': ['198.51.100.7'] } }
			)
		);
		ingress('stderr', '2027-01-15T08:00:00.000000002Z', caddy());
		ingress('stdout', '2027-01-15T08:00:00.000000003Z', '{"level":"info","logger":"admin"}');
		runtime.followers.get('tl-tcp-env_1-svc_1')!.onLine(
			'stdout',
			'2027-01-15T08:00:01Z',
			accessLine({
				port: 15432,
				client: '203.0.113.9',
				outcome: 'proxied',
				durationMs: 5,
				bytesIn: 1,
				bytesOut: 2
			})
		);
		expect(shipper.queued).toBe(2);
		await shipper.flush();
		expect(send.mock.calls[0]![0].map((e) => [e.kind, e.client])).toEqual([
			['http', '198.51.100.7'],
			['tcp', '203.0.113.9']
		]);
	});

	it('trusts the configured proxies, and lets go of containers that are gone', async () => {
		const { runtime, shipper, send } = setup();
		const ingress = container('tramline-ingress-n', 'ingress');
		await shipper.sync([ingress], ['10.0.0.0/8']);
		runtime.followers
			.get('tramline-ingress-n')!
			.onLine(
				'stdout',
				'2027-01-15T08:00:00Z',
				caddy({}, { remote_ip: '10.1.2.3', headers: { 'X-Forwarded-For': ['198.51.100.7'] } })
			);
		await shipper.flush();
		expect(send.mock.calls[0]![0][0]!.client).toBe('198.51.100.7');

		await shipper.sync([]);
		expect(runtime.followers.size).toBe(0);
		// re-attached later: from the last entry it saw, skipping what it already sent
		await shipper.sync([ingress], ['10.0.0.0/8']);
		const follower = runtime.followers.get('tramline-ingress-n')!;
		expect(follower.since).toBe(1_800_000_000 - 5);
		shipper.stop();
		expect(runtime.followers.size).toBe(0);
	});

	it('re-reads a container after its log stream ends, from the last entry shipped', async () => {
		const { runtime, shipper } = setup();
		const ingress = container('tramline-ingress-n', 'ingress');
		await shipper.sync([ingress]);
		const first = runtime.followers.get('tramline-ingress-n')!;
		first.onLine('stdout', '2027-01-15T08:00:00Z', caddy());
		first.onEnd();
		runtime.followers.delete('tramline-ingress-n');
		await shipper.sync([ingress]);
		const again = runtime.followers.get('tramline-ingress-n')!;
		expect(again.since).toBe(Math.floor(Date.parse('2027-01-15T08:00:00Z') / 1000));
		// what was already shipped is skipped
		again.onLine('stdout', '2027-01-15T08:00:00Z', caddy());
		again.onLine('stdout', '2027-01-15T08:00:01Z', caddy());
		expect(shipper.queued).toBe(2);
	});

	it('keeps the newest entries when the control plane is away, and retries', async () => {
		const send = vi.fn<(entries: AccessEntry[]) => Promise<void>>(async () => {
			throw new Error('away');
		});
		const { runtime, shipper } = setup(send);
		await shipper.sync([container('tramline-ingress-n', 'ingress')]);
		const onLine = runtime.followers.get('tramline-ingress-n')!.onLine;
		for (let i = 0; i < 5; i++) {
			onLine('stdout', `2027-01-15T08:00:0${i}Z`, caddy({ size: i }));
		}
		expect(shipper.queued).toBe(3);
		await expect(shipper.flush()).rejects.toThrow('away');
		expect(shipper.queued).toBe(3);
		send.mockResolvedValue(undefined);
		await shipper.flush();
		expect(send.mock.calls.at(-1)![0].map((e) => e.kind === 'http' && e.bytes)).toEqual([2, 3]);
		await shipper.flush();
		await shipper.flush();
		expect(shipper.queued).toBe(0);
	});

	it('stops sending for a while to a control plane without the endpoint', async () => {
		let now = 1_800_000_000_000;
		const send = vi.fn(async (_entries: AccessEntry[]) => {
			throw new ControlPlaneError(404, 'Not found');
		});
		const { runtime, shipper } = setup(send, () => now);
		await shipper.sync([container('tramline-ingress-n', 'ingress')]);
		const onLine = runtime.followers.get('tramline-ingress-n')!.onLine;
		onLine('stdout', '2027-01-15T08:00:00Z', caddy());
		await shipper.flush();
		expect(shipper.queued).toBe(0);
		onLine('stdout', '2027-01-15T08:00:01Z', caddy());
		await shipper.flush();
		expect(send).toHaveBeenCalledTimes(1);
		now += UNSUPPORTED_RETRY_MS;
		onLine('stdout', '2027-01-15T08:00:02Z', caddy());
		await shipper.flush();
		expect(send).toHaveBeenCalledTimes(2);
	});

	it('looks up the gateways of the networks the ingress is on', async () => {
		const { runtime, shipper } = setup();
		const lookups = vi.spyOn(runtime, 'networkGateway');
		const ingress = container('tramline-ingress-n', 'ingress', {
			networks: ['tl-env_1', 'missing']
		});
		await shipper.sync([ingress]);
		await shipper.sync([ingress]);
		expect(lookups).toHaveBeenCalledTimes(2);
		expect(MAX_QUEUED_ENTRIES).toBeGreaterThan(1000);
	});
});
