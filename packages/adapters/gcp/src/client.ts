import { AdapterError } from '@tramline/adapter-sdk';
import { createHash, createSign } from 'node:crypto';

/**
 * A small client for the Compute Engine API, signed in as a service account:
 * the key signs a JWT that Google's token endpoint exchanges for an access
 * token (an hour long), so nothing beyond Node is needed.
 */

export interface ServiceAccountKey {
	project_id: string;
	client_email: string;
	private_key: string;
	token_uri?: string;
}

export const COMPUTE = 'https://compute.googleapis.com/compute/v1/';
const SCOPE = 'https://www.googleapis.com/auth/compute';

export interface ClientOptions {
	fetch?: typeof fetch;
	/** How often to check a running operation; tests make it fast. */
	pollMs?: number;
	operationTimeoutMs?: number;
}

/** A Google API error, with the reason Google gives (`notFound`, `alreadyExists`, …). */
export class GoogleError extends AdapterError {
	constructor(
		message: string,
		readonly status: number,
		readonly reason: string | null
	) {
		super(message);
	}
}

interface Operation {
	name: string;
	status: 'PENDING' | 'RUNNING' | 'DONE';
	zone?: string;
	error?: { errors: { code: string; message: string }[] };
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** Access tokens by service account, shared by every client for that key. */
const tokens = new Map<string, { token: string; expiresAt: number }>();

export class GcpClient {
	readonly #fetch: typeof fetch;

	constructor(
		private key: ServiceAccountKey,
		private options: ClientOptions = {}
	) {
		this.#fetch = options.fetch ?? fetch;
	}

	get project() {
		return this.key.project_id;
	}

	async #token() {
		const cacheKey = createHash('sha256')
			.update(`${this.key.client_email}\n${this.key.private_key}`)
			.digest('hex');
		const cached = tokens.get(cacheKey);
		if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

		const audience = this.key.token_uri ?? 'https://oauth2.googleapis.com/token';
		const now = Math.floor(Date.now() / 1000);
		const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
		const claims = base64url(
			JSON.stringify({
				iss: this.key.client_email,
				scope: SCOPE,
				aud: audience,
				iat: now,
				exp: now + 3600
			})
		);
		let signature: string;
		try {
			signature = createSign('RSA-SHA256')
				.update(`${header}.${claims}`)
				.sign(this.key.private_key, 'base64url');
		} catch {
			throw new AdapterError('The service account key’s private key couldn’t be read');
		}
		const response = await this.#send(audience, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
				assertion: `${header}.${claims}.${signature}`
			})
		});
		const body = (await response.json().catch(() => null)) as {
			access_token?: string;
			expires_in?: number;
			error_description?: string;
			error?: string;
		} | null;
		if (!response.ok || !body?.access_token) {
			throw new AdapterError(
				`Google refused the service account key: ${body?.error_description ?? body?.error ?? `HTTP ${response.status}`}. It may have been deleted or disabled.`
			);
		}
		tokens.set(cacheKey, {
			token: body.access_token,
			expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000
		});
		return body.access_token;
	}

	async #send(url: string, init: RequestInit) {
		try {
			return await this.#fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
		} catch (error) {
			throw new AdapterError(
				`Couldn’t reach Google Cloud: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/** A Compute API call; `path` is relative to `projects/<project>/`, or a full URL. */
	async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = path.startsWith('https://')
			? path
			: `${COMPUTE}projects/${encodeURIComponent(this.project)}/${path}`;
		if (!url.startsWith(COMPUTE)) throw new AdapterError('Only the Compute Engine API is used');
		const response = await this.#send(url, {
			method,
			headers: {
				authorization: `Bearer ${await this.#token()}`,
				...(body === undefined ? {} : { 'content-type': 'application/json' })
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const parsed = (await response.json().catch(() => null)) as
			| (T & { error?: { message?: string; errors?: { reason?: string }[]; status?: string } })
			| null;
		if (!response.ok) {
			const error = parsed?.error;
			const reason = error?.errors?.[0]?.reason ?? error?.status ?? null;
			throw new GoogleError(
				explain(response.status, error?.message ?? `HTTP ${response.status}`, this.project),
				response.status,
				reason
			);
		}
		return parsed as T;
	}

	get<T>(path: string) {
		return this.call<T>('GET', path);
	}

	/** Waits for a zonal or global operation, and fails with its first error. */
	async wait(operation: Operation) {
		const deadline = Date.now() + (this.options.operationTimeoutMs ?? 10 * 60_000);
		let op = operation;
		const path = op.zone
			? `zones/${op.zone.split('/').pop()}/operations/${op.name}`
			: `global/operations/${op.name}`;
		while (op.status !== 'DONE') {
			if (Date.now() > deadline) throw new AdapterError('A Google Cloud operation took too long');
			await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 2_000));
			op = await this.get<Operation>(path);
		}
		const first = op.error?.errors[0];
		if (first) throw new GoogleError(first.message, 400, first.code);
	}
}

/** Google's messages, with what to do about the usual ones. */
function explain(status: number, message: string, project: string) {
	if (/has not been used in project|is disabled/.test(message)) {
		return `The Compute Engine API is off in project ${project}. Turn it on under APIs & Services → Library, wait a minute, then try again.`;
	}
	if (/billing/i.test(message)) {
		return `Project ${project} needs a billing account before it can create machines.`;
	}
	if (status === 403) {
		return `Google Cloud refused: ${message}. Give the service account the Compute Instance Admin (v1) role on project ${project}.`;
	}
	return `Google Cloud: ${message}`;
}
