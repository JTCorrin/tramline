import { ACCESS_AGENT_MAX, ACCESS_PATH_MAX, type AccessEntry } from '@tramline/contracts';
import { isIP } from 'node:net';
import { ControlPlaneError } from './client';
import { LABELS, type ContainerRuntime, type ManagedContainer } from './runtime';
import { allowlist } from './tcp-proxy';

/**
 * Access logs: what came in through this node's ingress (Caddy's JSON access
 * log, on the ingress's stdout) and its TCP proxies (a JSON line per
 * connection), sent to the control plane in batches.
 */

/** What the agent holds while the control plane is slow or away; older entries go first. */
export const MAX_QUEUED_ENTRIES = 20_000;
/** A control plane without the access endpoint (older than this agent) is asked again this often. */
export const UNSUPPORTED_RETRY_MS = 10 * 60_000;

/** The logger the ingress writes its tunnel server's requests to: `http.log.access.tunnel`. */
export const TUNNEL_LOGGER = 'tunnel';

export interface ClientContext {
	/** Addresses on the ingress's networks that are the host itself, where the tunnel connector arrives from. */
	gateways: Set<string>;
	/** TRAMLINE_TRUSTED_PROXIES: proxies whose X-Forwarded-For is believed. */
	trusted: (address: string) => boolean;
}

const unmap = (address: string) => (address.startsWith('::ffff:') ? address.slice(7) : address);

const header = (headers: Record<string, unknown>, name: string) => {
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== name) continue;
		if (Array.isArray(value)) return value.map(String);
		if (typeof value === 'string') return [value];
	}
	return [];
};

/**
 * Who sent a request. The connecting address, unless it is a proxy we trust:
 * the tunnel connector (only on the tunnel server, and only from the host;
 * service containers share networks with the ingress and could set the
 * header themselves), whose Cloudflare header names the visitor, or one of
 * TRAMLINE_TRUSTED_PROXIES, whose X-Forwarded-For is read from the right,
 * skipping proxies we trust.
 */
export function clientAddress(
	remote: string,
	headers: Record<string, unknown>,
	tunnel: boolean,
	context: ClientContext
) {
	const from = unmap(remote);
	if (tunnel && (context.gateways.has(from) || from === '127.0.0.1' || from === '::1')) {
		const visitor = header(headers, 'cf-connecting-ip')[0]?.trim();
		if (visitor && isIP(visitor)) return unmap(visitor);
	}
	if (!context.trusted(from)) return from;
	const chain = header(headers, 'x-forwarded-for')
		.flatMap((value) => value.split(','))
		.map((value) => unmap(value.trim()));
	for (let i = chain.length - 1; i >= 0; i--) {
		const hop = chain[i]!;
		// a malformed hop: anything to its left could have been written by anyone
		if (!isIP(hop)) break;
		if (!context.trusted(hop)) return hop;
	}
	return from;
}

const clip = (value: string, max: number) =>
	value.length > max ? value.slice(0, max) + '…' : value;

const timestamp = (ts: unknown) => {
	const date =
		typeof ts === 'number' ? new Date(ts * 1000) : typeof ts === 'string' ? new Date(ts) : null;
	return date && !Number.isNaN(date.getTime()) ? date.toISOString() : new Date().toISOString();
};

/** Caddy logs durations in seconds (a float), or as a string like "1.5ms" when configured to. */
const millis = (duration: unknown) =>
	typeof duration === 'number' && Number.isFinite(duration) ? Math.max(0, duration * 1000) : 0;

const count = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

/** One line of Caddy's JSON access log; null for anything else Caddy writes. */
export function parseCaddyLine(line: string, context: ClientContext): AccessEntry | null {
	let entry: Record<string, unknown>;
	try {
		entry = JSON.parse(line);
	} catch {
		return null;
	}
	const logger = entry?.logger;
	if (typeof logger !== 'string' || !logger.startsWith('http.log.access')) return null;
	const request = (entry.request ?? {}) as Record<string, unknown>;
	const headers = (request.headers ?? {}) as Record<string, unknown>;
	const tunnel = logger === `http.log.access.${TUNNEL_LOGGER}`;
	const remote = typeof request.remote_ip === 'string' ? request.remote_ip : '';
	if (!isIP(unmap(remote))) return null;
	const host = String(request.host ?? '')
		.replace(/:\d+$/, '')
		.toLowerCase();
	const agent = header(headers, 'user-agent')[0];
	return {
		kind: 'http',
		ts: timestamp(entry.ts),
		host: clip(host, 253).slice(0, 253),
		method: String(request.method ?? '').slice(0, 16),
		path: clip(String(request.uri ?? ''), ACCESS_PATH_MAX),
		status: Math.min(999, count(entry.status)),
		durationMs: millis(entry.duration),
		bytes: count(entry.size),
		client: clientAddress(remote, headers, tunnel, context),
		userAgent: agent === undefined ? null : clip(agent, ACCESS_AGENT_MAX),
		tunnel
	};
}

/** One connection the TCP proxy logged (`{"access":"tcp",…}`); null for its other lines. */
export function parseProxyLine(line: string): AccessEntry | null {
	if (!line.startsWith('{')) return null;
	let entry: Record<string, unknown>;
	try {
		entry = JSON.parse(line);
	} catch {
		return null;
	}
	if (entry?.access !== 'tcp') return null;
	const outcome = entry.outcome;
	if (outcome !== 'proxied' && outcome !== 'refused' && outcome !== 'plaintext') return null;
	const client = unmap(String(entry.client ?? ''));
	const port = count(entry.port);
	if (!isIP(client) || port < 1 || port > 65535) return null;
	return {
		kind: 'tcp',
		ts: timestamp(entry.ts),
		port,
		client,
		outcome,
		durationMs: Math.max(0, Number(entry.durationMs) || 0),
		bytesIn: count(entry.bytesIn),
		bytesOut: count(entry.bytesOut)
	};
}

const ROLES = new Set(['ingress', 'tcp-proxy']);

/**
 * Follows the ingress and the TCP proxies and ships what they log about
 * incoming traffic. A container is read from when this agent started (or
 * from the last entry it shipped), so an agent restart doesn't send the
 * container's whole history again; what arrived while the agent was down
 * is read, as long as Docker kept it.
 */
export class AccessShipper {
	#followers = new Map<string, () => void>();
	#lastTs = new Map<string, string>();
	#buffer: AccessEntry[] = [];
	#context: ClientContext = { gateways: new Set(), trusted: () => false };
	#trustedKey = '';
	#gateways = new Map<string, string | null>();
	#unsupportedUntil = 0;
	readonly #startedAt: number;

	constructor(
		private runtime: ContainerRuntime,
		private send: (entries: AccessEntry[]) => Promise<void>,
		private options: { maxBatch?: number; maxQueued?: number; now?: () => number } = {}
	) {
		this.#startedAt = Math.floor(this.#now() / 1000) - 5;
	}

	#now() {
		return this.options.now?.() ?? Date.now();
	}

	get queued() {
		return this.#buffer.length;
	}

	/** Who to believe about client addresses; the ingress's gateways are looked up once per network. */
	async sync(containers: ManagedContainer[], trustedProxies: string[] = []) {
		const key = trustedProxies.join(',');
		if (key !== this.#trustedKey) {
			this.#trustedKey = key;
			this.#context = { ...this.#context, trusted: allowlist(trustedProxies) };
		}
		const ingress = containers.find((c) => c.labels[LABELS.role] === 'ingress');
		for (const network of ingress?.networks ?? []) {
			if (this.#gateways.has(network)) continue;
			this.#gateways.set(network, await this.runtime.networkGateway(network).catch(() => null));
		}
		this.#context = {
			...this.#context,
			gateways: new Set(
				(ingress?.networks ?? []).map((n) => this.#gateways.get(n)).filter((g): g is string => !!g)
			)
		};

		const followed = containers.filter(
			(c) => ROLES.has(c.labels[LABELS.role] ?? '') && c.status === 'running'
		);
		const names = new Set(followed.map((c) => c.name));
		for (const [name, stop] of this.#followers) {
			if (names.has(name)) continue;
			stop();
			this.#followers.delete(name);
			this.#lastTs.delete(name);
		}
		for (const container of followed) {
			if (!this.#followers.has(container.name)) this.#attach(container);
		}
	}

	#attach(container: ManagedContainer) {
		const parse =
			container.labels[LABELS.role] === 'ingress'
				? (line: string) => parseCaddyLine(line, this.#context)
				: parseProxyLine;
		const last = this.#lastTs.get(container.name);
		const since = last ? Math.floor(Date.parse(last) / 1000) : this.#startedAt;
		const stop = this.runtime.logs(
			container.name,
			since,
			(stream, ts, line) => {
				if (stream !== 'stdout' || (last && ts <= last)) return;
				if (ts > (this.#lastTs.get(container.name) ?? '')) this.#lastTs.set(container.name, ts);
				const entry = parse(line);
				if (entry) this.#push(entry);
			},
			() => this.#followers.delete(container.name)
		);
		this.#followers.set(container.name, stop);
	}

	#push(entry: AccessEntry) {
		this.#buffer.push(entry);
		this.#trim();
	}

	/** Keeps the newest entries within the queue's budget. */
	#trim() {
		const max = this.options.maxQueued ?? MAX_QUEUED_ENTRIES;
		if (this.#buffer.length > max) this.#buffer.splice(0, this.#buffer.length - max);
	}

	/**
	 * Sends a batch. On failure it goes back to the front of the queue; a
	 * control plane that doesn't know the endpoint yet gets nothing for a
	 * while, and what was queued for it is dropped rather than kept.
	 */
	async flush() {
		if (!this.#buffer.length) return;
		if (this.#now() < this.#unsupportedUntil) {
			this.#buffer = [];
			return;
		}
		const batch = this.#buffer.splice(0, this.options.maxBatch ?? 1000);
		try {
			await this.send(batch);
		} catch (error) {
			if (error instanceof ControlPlaneError && error.status === 404) {
				this.#unsupportedUntil = this.#now() + UNSUPPORTED_RETRY_MS;
				this.#buffer = [];
				return;
			}
			this.#buffer.unshift(...batch);
			this.#trim();
			throw error;
		}
	}

	stop() {
		for (const stop of this.#followers.values()) stop();
		this.#followers.clear();
	}
}
