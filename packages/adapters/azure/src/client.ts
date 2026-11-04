import { AdapterError } from '@tramline/adapter-sdk';
import { createHash } from 'node:crypto';

/**
 * A small client for Azure Resource Manager, signed in as a service
 * principal (an app registration's client secret) with the OAuth client
 * credentials flow, so nothing beyond Node is needed.
 */

export interface ServicePrincipal {
	tenantId: string;
	clientId: string;
	clientSecret: string;
	subscriptionId: string;
}

export const ARM = 'https://management.azure.com/';
export const LOGIN = 'https://login.microsoftonline.com/';
const SCOPE = 'https://management.azure.com/.default';

export interface ClientOptions {
	fetch?: typeof fetch;
	/** How often to check a running operation; tests make it fast. */
	pollMs?: number;
	operationTimeoutMs?: number;
}

/** An Azure error, with the code Azure gives (`ResourceNotFound`, `AuthorizationFailed`, …). */
export class AzureError extends AdapterError {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string | null
	) {
		super(message);
	}
}

/** Access tokens by service principal, shared by every client for it. */
const tokens = new Map<string, { token: string; expiresAt: number }>();

export class AzureClient {
	readonly #fetch: typeof fetch;

	constructor(
		private principal: ServicePrincipal,
		private options: ClientOptions = {}
	) {
		this.#fetch = options.fetch ?? fetch;
	}

	get subscription() {
		return this.principal.subscriptionId;
	}

	async #token() {
		const { tenantId, clientId, clientSecret } = this.principal;
		const cacheKey = createHash('sha256')
			.update(`${tenantId}\n${clientId}\n${clientSecret}`)
			.digest('hex');
		const cached = tokens.get(cacheKey);
		if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

		const response = await this.#send(`${LOGIN}${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'client_credentials',
				client_id: clientId,
				client_secret: clientSecret,
				scope: SCOPE
			})
		});
		const body = (await response.json().catch(() => null)) as {
			access_token?: string;
			expires_in?: number;
			error?: string;
			error_description?: string;
		} | null;
		if (!response.ok || !body?.access_token) {
			throw new AdapterError(signInError(body?.error_description ?? body?.error, response.status));
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
				`Couldn’t reach Azure: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	async #request(method: string, path: string, body?: unknown) {
		const url = path.startsWith('https://')
			? path
			: `${ARM}subscriptions/${encodeURIComponent(this.subscription)}${path.startsWith('?') ? '' : '/'}${path}`;
		if (!url.startsWith(ARM)) throw new AdapterError('Only Azure Resource Manager is used');
		const response = await this.#send(url, {
			method,
			headers: {
				authorization: `Bearer ${await this.#token()}`,
				...(body === undefined ? {} : { 'content-type': 'application/json' })
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const parsed = (await response.json().catch(() => null)) as {
			error?: { code?: string; message?: string };
		} | null;
		if (!response.ok) {
			const code = parsed?.error?.code ?? null;
			throw new AzureError(
				explain(response.status, code, parsed?.error?.message ?? `HTTP ${response.status}`),
				response.status,
				code
			);
		}
		return { response, body: parsed };
	}

	/** A Resource Manager call; `path` is relative to `subscriptions/<id>/`, or a full URL. */
	async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		return (await this.#request(method, path, body)).body as T;
	}

	get<T>(path: string) {
		return this.call<T>('GET', path);
	}

	/** A PUT or DELETE that Azure may finish later: waits for it, and fails with its error. */
	async run<T>(method: 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
		const { response, body: result } = await this.#request(method, path, body);
		const async = response.headers.get('azure-asyncoperation');
		const location = response.headers.get('location');
		if (async) await this.#poll(async);
		else if (response.status === 202 && location) await this.#poll(location, true);
		return result as T;
	}

	async #poll(url: string, byLocation = false) {
		const deadline = Date.now() + (this.options.operationTimeoutMs ?? 10 * 60_000);
		for (;;) {
			if (Date.now() > deadline) throw new AdapterError('An Azure operation took too long');
			await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 2_000));
			const { response, body } = await this.#request('GET', url);
			if (byLocation) {
				if (response.status !== 202) return;
				continue;
			}
			const op = body as { status?: string; error?: { code?: string; message?: string } };
			if (op.status === 'Succeeded') return;
			if (op.status === 'Failed' || op.status === 'Canceled') {
				const code = op.error?.code ?? null;
				throw new AzureError(
					explain(400, code, op.error?.message ?? `The operation was ${op.status.toLowerCase()}`),
					400,
					code
				);
			}
		}
	}
}

/** Entra ID's sign-in errors, by their AADSTS code. */
function signInError(description: string | undefined, status: number) {
	const text = description ?? `HTTP ${status}`;
	if (/AADSTS7000215/.test(text)) {
		return 'Azure refused the client secret. Check you copied its Value (not its Secret ID), and that it hasn’t expired.';
	}
	if (/AADSTS700016/.test(text)) {
		return 'Azure has no app with that client ID in this tenant. Check the Application (client) ID and the Directory (tenant) ID.';
	}
	if (/AADSTS90002|AADSTS900023/.test(text)) {
		return 'Azure has no tenant with that ID. Use the Directory (tenant) ID from the app’s overview page.';
	}
	return `Azure refused to sign in: ${text.split('\n')[0]}`;
}

/** Azure's messages, with what to do about the usual ones. */
function explain(status: number, code: string | null, message: string) {
	if (code === 'MissingSubscriptionRegistration') {
		return `The subscription can’t use this service yet: ${message} Register Microsoft.Compute and Microsoft.Network under Subscription → Resource providers, then try again.`;
	}
	if (code === 'SubscriptionNotFound' || code === 'InvalidSubscriptionId') {
		return 'Azure has no subscription with that ID that the app can see. Check the subscription ID, and give the app a role on it.';
	}
	if (code === 'AuthorizationFailed' || code === 'LinkedAuthorizationFailed' || status === 403) {
		return `Azure refused: ${message} Give the app the Contributor role on the subscription, or on the resource group.`;
	}
	if (code === 'SkuNotAvailable') {
		return `That size isn’t available in this region for the subscription right now (${message}). Try another size or region.`;
	}
	if (code && /Quota/i.test(code)) {
		return `The subscription’s quota doesn’t allow this: ${message} Request more under Subscription → Usage + quotas, or pick a smaller size.`;
	}
	return `Azure: ${message}`;
}
