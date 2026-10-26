import type { DesiredMesh } from '@tramline/contracts';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Converger } from './converge';
import { applyTunnel, Forwarder, run, runMeshDaemon } from './mesh-daemon';
import {
	MESH_CONFIG_PATH,
	meshContainerName,
	meshKeys,
	meshNetworkName,
	publicKeyFor,
	type MeshConfig
} from './mesh';
import { SOCAT_IMAGE } from './pins';
import { LABELS } from './runtime';
import { desiredState, FakeRuntime } from './testing';

const MESH = meshContainerName('node_1');
const NETWORK = meshNetworkName('node_1');

const mesh: DesiredMesh = {
	address: '10.231.0.1',
	cidr: '10.231.0.0/16',
	listenPort: 51820,
	relay: false,
	peers: [
		{
			nodeId: 'node_2',
			publicKey: 'B'.repeat(43) + '=',
			endpoint: '198.51.100.2:51820',
			allowedIps: ['10.231.0.2/32'],
			keepalive: true
		}
	],
	forwards: [
		{ to: 'remote', port: 24000, address: '10.231.0.2' },
		{ to: 'local', port: 25000, target: 'web.production.tramline.internal:80', network: 'tl-env_1' }
	],
	links: [
		{
			name: 'tl-link-env_1-svc_db',
			network: 'tl-env_1',
			alias: 'postgres.production.tramline.internal',
			port: 5432,
			meshPort: 24000
		}
	]
};

function setup(endpoint: string | null = null) {
	const runtime = new FakeRuntime();
	const converger = new Converger(runtime, {
		nodeId: 'node_1',
		mesh: { image: 'tramline-agent:test', privateKey: 'PRIVATE', endpoint }
	});
	const desired = (m: DesiredMesh | null) => ({
		...desiredState(),
		networks: ['tl-env_1', ...(m ? [NETWORK] : [])],
		mesh: m
	});
	return { runtime, converger, desired };
}

describe('mesh keys', () => {
	it('creates a WireGuard key pair once and keeps the private half to itself', () => {
		const dir = path.join(mkdtempSync(path.join(tmpdir(), 'tl-mesh-')), 'state');
		const keys = meshKeys(dir);
		expect(keys.privateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
		expect(keys.publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
		expect(meshKeys(dir)).toEqual(keys);
		expect(statSync(path.join(dir, 'mesh.key')).mode & 0o777).toBe(0o600);
	});

	it('derives public keys the way wg pubkey does', () => {
		// RFC 7748 §6.1 test vector (Alice)
		const alice = Buffer.from(
			'77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
			'hex'
		).toString('base64');
		expect(Buffer.from(publicKeyFor(alice), 'base64').toString('hex')).toBe(
			'8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'
		);
	});
});

describe('Converger mesh', () => {
	it('runs the mesh container with NET_ADMIN only, and hands it its config', async () => {
		const { runtime, converger, desired } = setup('203.0.113.9:41820');
		await converger.run(desired(mesh));

		const container = runtime.containers.get(MESH)!;
		expect(container.spec).toMatchObject({
			image: 'tramline-agent:test',
			cmd: ['mesh'],
			network: NETWORK,
			ports: [{ container: 51820, host: 41820, protocol: 'udp' }],
			sysctls: { 'net.ipv4.ip_forward': '1' },
			security: { capabilities: ['NET_ADMIN'] }
		});
		expect(container.labels[LABELS.role]).toBe('mesh');
		// it delivers to this node's services through their environment network
		expect(container.networks).toEqual([NETWORK, 'tl-env_1']);

		const config = JSON.parse(
			runtime.files.get(`${MESH}:${MESH_CONFIG_PATH}`)!.toString()
		) as MeshConfig;
		expect(config).toMatchObject({
			address: '10.231.0.1',
			privateKey: 'PRIVATE',
			transitAddress: '172.30.0.2',
			forwards: mesh.forwards
		});
		expect(config).not.toHaveProperty('links');
	});

	it('runs a link per remote service on the environment network, joined to the mesh network', async () => {
		const { runtime, converger, desired } = setup();
		await converger.run(desired(mesh));
		const link = runtime.containers.get('tl-link-env_1-svc_db')!;
		expect(link.spec).toMatchObject({
			image: SOCAT_IMAGE,
			cmd: ['TCP-LISTEN:5432,fork,reuseaddr', `TCP:${MESH}:24000`],
			network: 'tl-env_1',
			aliases: ['postgres.production.tramline.internal'],
			security: { capabilities: [], readOnlyRootFilesystem: true }
		});
		expect(link.networks).toEqual(['tl-env_1', NETWORK]);
		expect(runtime.containers.get(MESH)!.spec.ports![0]!.host).toBe(51820);

		// a link that changes is replaced; one that goes away is removed
		await converger.run(desired({ ...mesh, links: [{ ...mesh.links[0]!, meshPort: 24001 }] }));
		expect(runtime.containers.get('tl-link-env_1-svc_db')!.spec.cmd).toEqual([
			'TCP-LISTEN:5432,fork,reuseaddr',
			`TCP:${MESH}:24001`
		]);
		await converger.run(desired({ ...mesh, links: [] }));
		expect(runtime.containers.has('tl-link-env_1-svc_db')).toBe(false);
	});

	it('leaves the mesh when there is none, and only rewrites the config when it changes', async () => {
		const { runtime, converger, desired } = setup();
		await converger.run(desired(mesh));
		runtime.files.delete(`${MESH}:${MESH_CONFIG_PATH}`);
		await converger.run({ ...desired(mesh), revision: 'again' });
		expect(runtime.files.has(`${MESH}:${MESH_CONFIG_PATH}`)).toBe(false);

		await converger.run(desired(null));
		expect(runtime.containers.has(MESH)).toBe(false);
		expect(runtime.containers.has('tl-link-env_1-svc_db')).toBe(false);
	});

	it('keeps serving its own routes when the mesh cannot start', async () => {
		const { runtime, desired } = setup();
		runtime.failPull.set('tramline-agent:test', 'manifest unknown');
		const logs: string[] = [];
		const withLog = new Converger(runtime, {
			nodeId: 'node_1',
			log: (line) => logs.push(line),
			mesh: { image: 'tramline-agent:test', privateKey: 'PRIVATE', endpoint: null }
		});
		await withLog.run(desired(mesh));
		expect(runtime.containers.has(MESH)).toBe(false);
		expect(runtime.containers.has('tramline-ingress-node_1')).toBe(true);
		expect(logs.join('\n')).toContain('the mesh failed');
	});

	it('stays out of the mesh without a key', async () => {
		const runtime = new FakeRuntime();
		const converger = new Converger(runtime, { nodeId: 'node_1' });
		await converger.run({ ...desiredState(), mesh });
		expect(runtime.containers.has(MESH)).toBe(false);
	});
});

describe('mesh daemon', () => {
	const config: MeshConfig = {
		...mesh,
		privateKey: 'PRIVATE',
		transitAddress: '127.0.0.1'
	};

	it('sets up WireGuard and its peers, removing ones that left', async () => {
		const calls: string[] = [];
		const inputs: string[] = [];
		const exec = async (cmd: string, args: string[], input?: string) => {
			calls.push([cmd, ...args].join(' '));
			if (input) inputs.push(input);
			if (args.join(' ') === `show wg0 peers`) return 'OLDKEY=\n' + mesh.peers[0]!.publicKey + '\n';
			return '';
		};
		await applyTunnel(config, exec);
		// the key reaches wg on stdin, never on disk or in its arguments
		expect(inputs).toEqual(['PRIVATE\n']);
		expect(calls).toEqual([
			'ip link show',
			'ip link add wg0 type wireguard',
			'wg set wg0 listen-port 51820 private-key /dev/stdin',
			'ip address replace 10.231.0.1/16 dev wg0',
			'ip link set wg0 up',
			'wg show wg0 peers',
			'wg set wg0 peer OLDKEY= remove',
			`wg set wg0 peer ${mesh.peers[0]!.publicKey} endpoint 198.51.100.2:51820 allowed-ips 10.231.0.2/32 persistent-keepalive 25`
		]);
	});

	it('forwards TCP on exactly the address each forward belongs to', async () => {
		const echo = net.createServer((socket) => socket.pipe(socket));
		await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
		const target = (echo.address() as net.AddressInfo).port;
		const port = 30_000 + Math.floor(Math.random() * 20_000);

		const forwarder = new Forwarder(() => {});
		await forwarder.apply({
			...config,
			address: '127.0.0.1',
			forwards: [{ to: 'local', port, target: `127.0.0.1:${target}`, network: 'tl-env_1' }]
		});
		expect(forwarder.ports).toEqual([port]);

		const reply = await new Promise<string>((resolve, reject) => {
			const socket = net.connect(port, '127.0.0.1', () => socket.write('ping'));
			socket.on('data', (data) => {
				resolve(data.toString());
				socket.destroy();
			});
			socket.on('error', reject);
		});
		expect(reply).toBe('ping');

		await forwarder.apply({ ...config, forwards: [] });
		expect(forwarder.ports).toEqual([]);
		forwarder.close();
		echo.close();
	});

	it('applies each new config, and reports a broken one once', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'tl-meshd-'));
		const file = path.join(dir, 'mesh.json');
		const logs: string[] = [];
		const controller = new AbortController();
		const done = runMeshDaemon(file, {
			intervalMs: 5,
			exec: async () => '',
			log: (line) => logs.push(line),
			signal: controller.signal
		});
		const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
		await settle();
		writeFileSync(file, '{ not json');
		await settle();
		writeFileSync(file, JSON.stringify({ ...config, forwards: [] }));
		await settle();
		controller.abort();
		await done;
		expect(logs[0]).toBe('[mesh] waiting for config');
		expect(logs.filter((l) => l.includes('JSON')).length).toBe(1);
		expect(logs).toContain('[mesh] 10.231.0.1: 1 peers, forwarding 0 ports');
	});

	it('drops a connection whose service is unreachable, and reports a port it cannot bind', async () => {
		const taken = net.createServer();
		await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
		const busy = (taken.address() as net.AddressInfo).port;
		const closed = net.createServer();
		await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
		const nowhere = (closed.address() as net.AddressInfo).port;
		closed.close();

		const logs: string[] = [];
		const forwarder = new Forwarder((line) => logs.push(line));
		const port = 30_000 + Math.floor(Math.random() * 20_000);
		await forwarder.apply({
			...config,
			address: '127.0.0.1',
			forwards: [
				{ to: 'local', port: busy, target: '127.0.0.1:1', network: 'tl-env_1' },
				{ to: 'local', port, target: `127.0.0.1:${nowhere}`, network: 'tl-env_1' }
			]
		});
		expect(forwarder.ports).toEqual([port]);
		expect(logs.join('\n')).toContain(`port ${busy}: listen EADDRINUSE`);

		const ended = await new Promise<boolean>((resolve) => {
			const socket = net.connect(port, '127.0.0.1');
			socket.on('close', () => resolve(true));
			socket.on('error', () => {});
		});
		expect(ended).toBe(true);
		forwarder.close();
		taken.close();
	});

	it('runs commands with input on stdin, and reports their errors', async () => {
		expect(await run('cat', [], 'secret\n')).toBe('secret\n');
		await expect(run('sh', ['-c', 'echo oops >&2; exit 3'])).rejects.toThrow('sh -c failed: oops');
		await expect(run('sh', ['-c', 'exit 4'])).rejects.toThrow('sh -c failed: exit 4');
		await expect(run('/no/such/command', [])).rejects.toThrow('ENOENT');
	});
});
