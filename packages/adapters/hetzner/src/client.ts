import { AdapterError } from '@tramline/adapter-sdk';

/**
 * A small client for the Hetzner Cloud API: a project's API token as a
 * bearer token, JSON in and out, so nothing beyond Node is needed.
 */

export const API = 'https://api.hetzner.cloud/v1/';

export interface ClientOptions {
	fetch?: typeof fetch;
	/** How often to check a running action; tests make it fast. */
	pollMs?: number;
	actionTimeoutMs?: number;
}

/** A Hetzner error, with the code Hetzner gives (`not_found`, `uniqueness_error`, …). */
export class HetznerError extends AdapterError {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string | null
	) {
		super(message);
	}
}

export interface Action {
	id: number;
	command?: string;
	status: 'running' | 'success' | 'error';
	error?: { code?: string; message?: string } | null;
}

interface Page {
	meta?: { pagination?: { next_page?: number | null } };
}

export class HetznerClient {
	readonly #fetch: typeof fetch;

	constructor(
		private token: string,
		private options: ClientOptions = {}
	) {
		this.#fetch = options.fetch ?? fetch;
	}

	/** An API call; `path` is relative to `/v1/`. */
	async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		let response: Response;
		try {
			response = await this.#fetch(`${API}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${this.token}`,
					...(body === undefined ? {} : { 'content-type': 'application/json' })
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(60_000)
			});
		} catch (error) {
			throw new AdapterError(
				`Couldn’t reach Hetzner Cloud: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		// DELETE answers 204 with no body
		const parsed = (await response.json().catch(() => null)) as {
			error?: { code?: string; message?: string };
		} | null;
		if (!response.ok) {
			const code = parsed?.error?.code ?? null;
			throw new HetznerError(
				explain(response.status, code, parsed?.error?.message ?? `HTTP ${response.status}`),
				response.status,
				code
			);
		}
		return parsed as T;
	}

	get<T>(path: string) {
		return this.call<T>('GET', path);
	}

	/** Every item of a list, over every page; `path` may already have a query. */
	async list<T>(path: string, key: string): Promise<T[]> {
		const items: T[] = [];
		const join = path.includes('?') ? '&' : '?';
		for (let page: number | null | undefined = 1; page;) {
			const result: Page & Record<string, unknown> = await this.get(
				`${path}${join}per_page=50&page=${page}`
			);
			items.push(...((result[key] as T[] | undefined) ?? []));
			page = result.meta?.pagination?.next_page;
		}
		return items;
	}

	/** Waits for an action to finish, and fails with its error. */
	async wait(action: Action | null | undefined) {
		if (!action) return;
		const deadline = Date.now() + (this.options.actionTimeoutMs ?? 10 * 60_000);
		let current = action;
		while (current.status === 'running') {
			if (Date.now() > deadline) throw new AdapterError('A Hetzner Cloud action took too long');
			await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 2_000));
			current = (await this.get<{ action: Action }>(`actions/${current.id}`)).action;
		}
		if (current.status === 'error') {
			const code = current.error?.code ?? null;
			throw new HetznerError(
				explain(400, code, current.error?.message ?? `${current.command ?? 'An action'} failed`),
				400,
				code
			);
		}
	}
}

/** Hetzner's messages, with what to do about the usual ones. */
function explain(status: number, code: string | null, message: string) {
	if (code === 'unauthorized' || status === 401) {
		return 'Hetzner Cloud rejected the API token. Check you copied all of it, and that it hasn’t been deleted from the project.';
	}
	if (code === 'forbidden') {
		return `Hetzner Cloud refused: ${message}. The token may be read-only: create one with Read & Write under Security → API tokens.`;
	}
	if (code === 'resource_limit_exceeded') {
		return `The project has reached a Hetzner Cloud limit: ${message}. Pick a smaller size, or ask Hetzner to raise the limit.`;
	}
	if (code === 'resource_unavailable' || code === 'placement_error') {
		return `That size isn’t available in this location right now (${message}). Try another size or location.`;
	}
	if (code === 'rate_limit_exceeded') {
		return 'Hetzner Cloud’s rate limit was reached (3,600 requests an hour per project). Wait a few minutes, then try again.';
	}
	return `Hetzner Cloud: ${message}`;
}
