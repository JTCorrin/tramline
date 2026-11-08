import { AdapterError } from '@tramline/adapter-sdk';

/**
 * A small client for the Lambda Cloud API (https://docs.lambda.com/api/cloud):
 * an API key sent as a bearer token, JSON in and out, `{ data }` on success
 * and `{ error: { code, message, suggestion } }` on failure. Lambda allows
 * about one request a second (one launch every 12 seconds), so a 429 is
 * waited out and retried a few times.
 */

export const API = 'https://cloud.lambda.com/api/v1/';

export interface ClientOptions {
	fetch?: typeof fetch;
	/** How long to wait after a 429 without a Retry-After; tests make it fast. */
	retryMs?: number;
}

/** A Lambda error, with the code Lambda gives (`global/invalid-api-key`, …). */
export class LambdaError extends AdapterError {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string | null
	) {
		super(message);
	}
}

const RETRIES = 4;

export class LambdaClient {
	readonly #fetch: typeof fetch;

	constructor(
		private apiKey: string,
		private options: ClientOptions = {}
	) {
		this.#fetch = options.fetch ?? fetch;
	}

	async #send(url: string, init: RequestInit) {
		try {
			return await this.#fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
		} catch (error) {
			throw new AdapterError(
				`Couldn’t reach Lambda: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/** A call to `API` + `path`; resolves with the response's `data`. */
	async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = `${API}${path}`;
		for (let attempt = 0; ; attempt++) {
			const response = await this.#send(url, {
				method,
				headers: {
					authorization: `Bearer ${this.apiKey}`,
					accept: 'application/json',
					...(body === undefined ? {} : { 'content-type': 'application/json' })
				},
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			const parsed = (await response.json().catch(() => null)) as {
				data?: unknown;
				error?: { code?: string; message?: string; suggestion?: string };
			} | null;
			if (response.status === 429 && attempt < RETRIES) {
				const after = Number(response.headers.get('retry-after'));
				const wait =
					Number.isFinite(after) && after > 0
						? after * 1000
						: (this.options.retryMs ??
							(path.startsWith('instance-operations/launch') ? 12_000 : 2_000));
				await new Promise((resolve) => setTimeout(resolve, wait));
				continue;
			}
			if (!response.ok) {
				const code = parsed?.error?.code ?? null;
				const message = [parsed?.error?.message, parsed?.error?.suggestion]
					.filter(Boolean)
					.join(' ');
				throw new LambdaError(
					explain(response.status, code, message || `HTTP ${response.status}`),
					response.status,
					code
				);
			}
			return parsed?.data as T;
		}
	}

	get<T>(path: string) {
		return this.call<T>('GET', path);
	}
}

/** Lambda's messages, with what to do about the usual ones. */
function explain(status: number, code: string | null, message: string) {
	if (code === 'global/invalid-api-key' || status === 401) {
		return 'Lambda refused the API key. Check you copied all of it, or create a new one under API keys in the Lambda Cloud dashboard.';
	}
	if (code === 'global/account-inactive') {
		return `Lambda says the account is inactive: ${message}`;
	}
	if (code === 'global/invalid-address') {
		return `Lambda needs a valid billing address before it launches instances: ${message}`;
	}
	if (code === 'instance-operations/launch/insufficient-capacity') {
		return 'Lambda has none of that size free in this region right now. Try another size or region, or try again later.';
	}
	if (code === 'global/quota-exceeded') {
		return `The account’s quota doesn’t allow this: ${message} Ask Lambda support for more, or pick a smaller size.`;
	}
	if (code === 'global/forbidden' || status === 403) {
		return `Lambda refused: ${message} Check the API key’s role allows managing instances, SSH keys and firewall rules.`;
	}
	if (status === 429) return 'Lambda is limiting requests right now. Try again in a minute.';
	return `Lambda: ${message}`;
}
