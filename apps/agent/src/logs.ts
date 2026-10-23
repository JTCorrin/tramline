import type { LogLine } from '@tramline/contracts';
import { LABELS, type ContainerRuntime, type ManagedContainer } from './runtime';

/**
 * Follows the logs of every workload container and ships them to the control
 * plane in batches. Re-attaches after restarts without repeating lines.
 */
export class LogShipper {
	#followers = new Map<string, () => void>();
	/** Last timestamp shipped per container, so re-attaching skips what was sent. */
	#lastTs = new Map<string, string>();
	#buffer: LogLine[] = [];

	constructor(
		private runtime: ContainerRuntime,
		private send: (lines: LogLine[]) => Promise<void>,
		private maxBatch = 1000
	) {}

	/** Attaches to new running containers and detaches from removed ones. */
	sync(containers: ManagedContainer[]) {
		const workloads = containers.filter((c) => c.labels[LABELS.role] === 'workload');
		const names = new Set(workloads.map((c) => c.name));
		for (const [name, stop] of this.#followers) {
			if (!names.has(name)) {
				stop();
				this.#followers.delete(name);
				this.#lastTs.delete(name);
			}
		}
		for (const container of workloads) {
			if (container.status !== 'running' || this.#followers.has(container.name)) continue;
			this.#attach(container);
		}
	}

	#attach(container: ManagedContainer) {
		const deploymentId = container.labels[LABELS.deployment]!;
		const last = this.#lastTs.get(container.name);
		const since = last ? Math.floor(Date.parse(last) / 1000) : 0;
		const stop = this.runtime.logs(
			container.name,
			since,
			(stream, ts, line) => {
				if (last && ts <= last) return; // already shipped before a restart
				if (ts > (this.#lastTs.get(container.name) ?? '')) this.#lastTs.set(container.name, ts);
				this.#buffer.push({ deploymentId, ts, stream, line });
			},
			() => this.#followers.delete(container.name)
		);
		this.#followers.set(container.name, stop);
	}

	/** Queues lines that don't come from a container, e.g. build output. */
	push(line: LogLine) {
		this.#buffer.push(line);
	}

	/** Sends buffered lines; on failure they are kept for the next attempt (up to a cap). */
	async flush() {
		if (!this.#buffer.length) return;
		const batch = this.#buffer.splice(0, this.maxBatch);
		try {
			await this.send(batch);
		} catch (error) {
			this.#buffer.unshift(...batch.slice(-this.maxBatch * 5));
			throw error;
		}
	}

	stop() {
		for (const stop of this.#followers.values()) stop();
		this.#followers.clear();
	}
}
