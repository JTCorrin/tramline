import { AdapterError } from '@tramline/adapter-sdk';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';

/**
 * A small client for the Proxmox VE API (`/api2/json`), authenticated with an
 * API token. A private CA can be supplied for self-signed Proxmox hosts.
 * Chain, expiry and hostname validation always run; an optional SHA-256
 * fingerprint adds certificate pinning on top of those checks.
 */

export interface Connection {
	url: string;
	tokenId: string;
	tokenSecret: string;
	fingerprint?: string;
	caCertificate?: string;
}

const normalize = (fingerprint: string) => fingerprint.replace(/[^0-9a-f]/gi, '').toUpperCase();

type Params = Record<string, string | number | boolean | undefined>;

export class ProxmoxClient {
	readonly base: URL;

	constructor(
		private connection: Connection,
		private options: { pollMs?: number; taskTimeoutMs?: number } = {}
	) {
		const url = new URL(connection.url);
		if (url.protocol !== 'https:')
			throw new AdapterError('The Proxmox URL must start with https://');
		this.base = new URL('/api2/json/', url);
	}

	get<T>(path: string, params?: Params) {
		return this.#call<T>('GET', path, params);
	}

	post<T>(path: string, params?: Params) {
		return this.#call<T>('POST', path, params);
	}

	put<T>(path: string, params?: Params) {
		return this.#call<T>('PUT', path, params);
	}

	delete<T>(path: string, params?: Params) {
		return this.#call<T>('DELETE', path, params);
	}

	/** Waits for a task (a clone, a start, a delete) to finish, and fails if it did. */
	async wait(node: string, upid: string) {
		const deadline = Date.now() + (this.options.taskTimeoutMs ?? 10 * 60_000);
		for (;;) {
			const task = await this.get<{ status: string; exitstatus?: string }>(
				`nodes/${node}/tasks/${encodeURIComponent(upid)}/status`
			);
			if (task.status === 'stopped') {
				if (task.exitstatus !== 'OK') {
					throw new AdapterError(`A Proxmox task failed: ${task.exitstatus ?? 'unknown error'}`);
				}
				return;
			}
			if (Date.now() > deadline) throw new AdapterError('A Proxmox task took too long');
			await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 2_000));
		}
	}

	async #call<T>(method: string, path: string, params: Params = {}): Promise<T> {
		const url = new URL(path, this.base);
		if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) {
			throw new AdapterError('The Proxmox API path must stay within /api2/json/ on its host');
		}
		const form = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value === undefined) continue;
			const text = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
			if (method === 'GET' || method === 'DELETE') url.searchParams.set(key, text);
			else form.set(key, text);
		}
		const body = method === 'GET' || method === 'DELETE' ? undefined : form.toString();
		const { status, statusMessage, text } = await this.#send(method, url, body);
		if (status === 401) {
			throw new AdapterError('Proxmox rejected the API token; check its ID and secret');
		}
		if (status === 403) {
			throw new AdapterError(
				`The API token lacks a permission: ${statusMessage || 'permission check failed'}`
			);
		}
		if (status < 200 || status >= 300) {
			const detail = (() => {
				try {
					const errors = (JSON.parse(text) as { errors?: Record<string, string> }).errors;
					return errors ? Object.values(errors).join('; ') : '';
				} catch {
					return '';
				}
			})();
			throw new AdapterError(
				`Proxmox answered ${status}${statusMessage ? ` ${statusMessage}` : ''}${detail ? `: ${detail}` : ''}`
			);
		}
		return (JSON.parse(text) as { data: T }).data;
	}

	#send(method: string, url: URL, body?: string) {
		const pinned = this.connection.fingerprint ? normalize(this.connection.fingerprint) : null;
		return new Promise<{ status: number; statusMessage: string; text: string }>(
			(resolve, reject) => {
				const req = request(
					url,
					{
						method,
						headers: {
							authorization: `PVEAPIToken=${this.connection.tokenId}=${this.connection.tokenSecret}`,
							...(body !== undefined
								? {
										'content-type': 'application/x-www-form-urlencoded',
										'content-length': Buffer.byteLength(body)
									}
								: {})
						},
						timeout: 30_000,
						rejectUnauthorized: true,
						ca: this.connection.caCertificate || undefined,
						// Do not reuse a TLS session authenticated with another account's pin.
						agent: false,
						checkServerIdentity: (host, cert) => {
							const error = checkServerIdentity(host, cert);
							if (error) return error;
							if (pinned && normalize(cert.fingerprint256 ?? '') !== pinned) {
								return new AdapterError(`${url.host}'s certificate doesn't match the fingerprint`);
							}
						}
					},
					(res) => {
						const chunks: Buffer[] = [];
						res.on('data', (chunk: Buffer) => chunks.push(chunk));
						res.on('end', () =>
							resolve({
								status: res.statusCode ?? 0,
								statusMessage: res.statusMessage ?? '',
								text: Buffer.concat(chunks).toString()
							})
						);
						res.on('error', reject);
					}
				);
				req.on('timeout', () =>
					req.destroy(new AdapterError(`${url.host} did not answer in time`))
				);
				req.on('error', (error) =>
					reject(
						error instanceof AdapterError
							? error
							: new AdapterError(`Couldn't reach ${url.host}: ${error.message}`)
					)
				);
				req.end(body);
			}
		);
	}
}
