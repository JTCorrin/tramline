import {
	DesiredState,
	type AgentHello,
	type AgentReportInput,
	type QueryResult,
	type LogLine,
	type MetricsBatch
} from '@tramline/contracts';

export class ControlPlaneError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

/** The agent's HTTP client for `/api/agent/v1`. */
export class ControlPlane {
	readonly #base: string;

	constructor(
		url: string,
		public token: string,
		private fetcher: typeof fetch = globalThis.fetch
	) {
		this.#base = `${url.replace(/\/$/, '')}/api/agent/v1`;
	}

	async #request(path: string, init: RequestInit = {}) {
		const response = await this.fetcher(this.#base + path, {
			...init,
			headers: {
				authorization: `Bearer ${this.token}`,
				...(init.body ? { 'content-type': 'application/json' } : {})
			}
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as {
				error?: { message?: string };
			} | null;
			throw new ControlPlaneError(
				response.status,
				body?.error?.message ?? `HTTP ${response.status}`
			);
		}
		return response;
	}

	async hello(hello: AgentHello) {
		const response = await this.#request('/hello', { method: 'POST', body: JSON.stringify(hello) });
		return (await response.json()) as { nodeId: string; name: string };
	}

	/** Long-polls for a desired state newer than `revision`; null when nothing changed. */
	async desired(revision: string | null, signal?: AbortSignal): Promise<DesiredState | null> {
		const query = revision ? `?revision=${encodeURIComponent(revision)}` : '';
		const response = await this.#request(`/desired${query}`, { signal });
		// parsed, so fields a slightly older control plane leaves out get their defaults
		return response.status === 204 ? null : DesiredState.parse(await response.json());
	}

	/** Answers a data browser query. */
	async answer(id: string, result: QueryResult) {
		await this.#request(`/queries/${encodeURIComponent(id)}`, {
			method: 'POST',
			body: JSON.stringify(result)
		});
	}

	async report(report: AgentReportInput) {
		await this.#request('/report', { method: 'POST', body: JSON.stringify(report) });
	}

	async logs(lines: LogLine[]) {
		await this.#request('/logs', { method: 'POST', body: JSON.stringify({ lines }) });
	}

	async metrics(batch: MetricsBatch) {
		await this.#request('/metrics', { method: 'POST', body: JSON.stringify(batch) });
	}
}
