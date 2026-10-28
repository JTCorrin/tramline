import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import type { MeshConfig } from './mesh';

/**
 * Runs inside the mesh container (`agent.mjs mesh`): keeps the WireGuard
 * interface and the TCP forwards in line with the config file the agent
 * writes. The tunnel lives in this container's network namespace only; the
 * container has NET_ADMIN and nothing else.
 *
 * Forwards listen on exactly one address each: a forward to another node on
 * the mesh network (where only this node's links and ingress are), a
 * forward to a local service on the WireGuard address (where only other
 * nodes are). Nothing listens on the environment networks.
 */

export type Run = (cmd: string, args: string[], input?: string) => Promise<string>;

/** Runs a command, writing `input` to its standard input; rejects with its stderr on failure. */
export const run: Run = (cmd, args, input) =>
	new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		child.stdout!.on('data', (chunk) => (stdout += chunk));
		child.stderr!.on('data', (chunk) => (stderr += chunk));
		child.on('error', reject);
		child.on('close', (code) =>
			code === 0
				? resolve(stdout)
				: reject(new Error(`${cmd} ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`))
		);
		if (input !== undefined) {
			// a command that exits without reading its input must not take the daemon down
			child.stdin!.on('error', () => {});
			child.stdin!.end(input);
		}
	});

export const WG = 'wg0';

/**
 * Brings the WireGuard interface in line with `config`. Idempotent. The
 * private key goes to `wg` on standard input, so it is never written to disk.
 */
export async function applyTunnel(config: MeshConfig, exec: Run = run) {
	const links = await exec('ip', ['link', 'show']);
	if (!links.includes(`${WG}:`)) await exec('ip', ['link', 'add', WG, 'type', 'wireguard']);
	// Node hands a child its stdin as a socket, which wg can't open as /dev/stdin; cat puts
	// the key on a real pipe
	await exec(
		'sh',
		['-c', `cat | wg set ${WG} listen-port ${config.listenPort} private-key /dev/stdin`],
		config.privateKey + '\n'
	);
	const prefix = config.cidr.split('/')[1];
	await exec('ip', ['address', 'replace', `${config.address}/${prefix}`, 'dev', WG]);
	await exec('ip', ['link', 'set', WG, 'up']);

	const wanted = new Set(config.peers.map((p) => p.publicKey));
	for (const key of (await exec('wg', ['show', WG, 'peers'])).split('\n').filter(Boolean)) {
		if (!wanted.has(key)) await exec('wg', ['set', WG, 'peer', key, 'remove']);
	}
	for (const peer of config.peers) {
		await exec('wg', [
			'set',
			WG,
			'peer',
			peer.publicKey,
			...(peer.endpoint ? ['endpoint', peer.endpoint] : []),
			'allowed-ips',
			peer.allowedIps.join(','),
			'persistent-keepalive',
			peer.keepalive ? '25' : '0'
		]);
	}
}

interface Listener {
	key: string;
	server: net.Server;
}

/** Keeps one TCP listener per forward; changed forwards are replaced, removed ones closed. */
export class Forwarder {
	readonly #listeners = new Map<number, Listener>();

	constructor(private log: (message: string) => void = console.log) {}

	get ports() {
		return [...this.#listeners.keys()].sort((a, b) => a - b);
	}

	async apply(config: MeshConfig) {
		const wanted = new Map(
			config.forwards.map((f) => {
				const [host, port] =
					f.to === 'local'
						? [
								f.target.slice(0, f.target.lastIndexOf(':')),
								f.target.slice(f.target.lastIndexOf(':') + 1)
							]
						: [f.address, String(f.port)];
				const bind = f.to === 'local' ? config.address : config.transitAddress;
				return [f.port, { bind, host, port: Number(port), key: `${bind}>${host}:${port}` }];
			})
		);
		for (const [port, listener] of this.#listeners) {
			if (wanted.get(port)?.key !== listener.key) {
				listener.server.close();
				this.#listeners.delete(port);
			}
		}
		for (const [port, f] of wanted) {
			if (this.#listeners.has(port)) continue;
			const server = net.createServer((client) => {
				const upstream = net.connect(f.port, f.host);
				client.pipe(upstream).pipe(client);
				const close = () => {
					client.destroy();
					upstream.destroy();
				};
				client.on('error', close);
				upstream.on('error', close);
			});
			// a port that can't be bound is reported and tried again with the next config
			const listening = await new Promise<boolean>((resolve) => {
				server.once('error', (error) => {
					this.log(`[mesh] port ${port}: ${error.message}`);
					resolve(false);
				});
				server.listen(port, f.bind, () => resolve(true));
			});
			if (listening) this.#listeners.set(port, { key: f.key, server });
		}
	}

	close() {
		for (const { server } of this.#listeners.values()) server.close();
		this.#listeners.clear();
	}
}

export interface DaemonOptions {
	intervalMs?: number;
	exec?: Run;
	log?: (message: string) => void;
	signal?: AbortSignal;
}

/** Watches the config file and applies each new version, until `signal` aborts. */
export async function runMeshDaemon(path: string, options: DaemonOptions = {}) {
	const log = options.log ?? console.log;
	const forwarder = new Forwarder(log);
	let applied = '';
	let lastError = '';
	log('[mesh] waiting for config');
	while (!options.signal?.aborted) {
		try {
			const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
			if (text && text !== applied) {
				const config = JSON.parse(text) as MeshConfig;
				await applyTunnel(config, options.exec);
				await forwarder.apply(config);
				if (forwarder.ports.length !== config.forwards.length) {
					throw new Error('Some mesh forwards could not bind; retrying');
				}
				applied = text;
				lastError = '';
				log(
					`[mesh] ${config.address}: ${config.peers.length} peers, forwarding ${forwarder.ports.length} ports`
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message !== lastError) log(`[mesh] ${message}`);
			lastError = message;
		}
		await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1_000));
	}
	forwarder.close();
}
