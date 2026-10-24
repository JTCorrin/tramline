import type { ApiErrorBody, ErrorCode } from '@tramline/contracts';

export type Query = { [key: string]: string | number | boolean | null | undefined };

export interface ClientOptions {
	/** Base URL of the API, e.g. `/api/v1` in the browser or `https://tramline.example.com/api/v1` from the CLI. */
	baseUrl: string;
	/** Defaults to the global `fetch`. Pass SvelteKit's `event.fetch` during SSR. */
	fetch?: typeof fetch;
	/** API token for non-browser clients. Browser requests authenticate with the session cookie. */
	token?: string;
}

/** Thrown for every non-2xx response, carrying the API error envelope. */
export class ApiError extends Error {
	readonly status: number;
	readonly code: ErrorCode;
	readonly issues: ApiErrorBody['error']['issues'];

	constructor(status: number, body: ApiErrorBody['error']) {
		super(body.message);
		this.name = 'ApiError';
		this.status = status;
		this.code = body.code;
		this.issues = body.issues;
	}
}

export interface Http {
	get<T>(path: string, query?: Query): Promise<T>;
	post<T>(path: string, body?: unknown): Promise<T>;
	patch<T>(path: string, body: unknown): Promise<T>;
	put<T>(path: string, body: unknown): Promise<T>;
	delete<T>(path: string): Promise<T>;
}

export function createHttp(options: ClientOptions): Http {
	const baseUrl = options.baseUrl.replace(/\/$/, '');

	async function request<T>(method: string, path: string, body?: unknown, query?: Query) {
		const fetcher = options.fetch ?? globalThis.fetch;
		const headers: Record<string, string> = { accept: 'application/json' };
		if (body !== undefined) headers['content-type'] = 'application/json';
		if (options.token) headers.authorization = `Bearer ${options.token}`;

		const response = await fetcher(baseUrl + path + toSearch(query), {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body)
		});

		if (response.status === 204) return undefined as T;

		const data = await response.json().catch(() => null);
		if (!response.ok) {
			throw new ApiError(
				response.status,
				isErrorBody(data)
					? data.error
					: { code: 'internal', message: `Request failed with status ${response.status}` }
			);
		}
		return data as T;
	}

	return {
		get: (path, query) => request('GET', path, undefined, query),
		post: (path, body) => request('POST', path, body ?? {}),
		patch: (path, body) => request('PATCH', path, body),
		put: (path, body) => request('PUT', path, body),
		delete: (path) => request('DELETE', path)
	};
}

function toSearch(query?: Query) {
	if (!query) return '';
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined && value !== null) params.set(key, String(value));
	}
	const search = params.toString();
	return search ? `?${search}` : '';
}

function isErrorBody(data: unknown): data is ApiErrorBody {
	return (
		typeof data === 'object' &&
		data !== null &&
		'error' in data &&
		typeof (data as ApiErrorBody).error?.message === 'string'
	);
}
