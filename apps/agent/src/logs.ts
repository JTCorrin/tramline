import type { LogLine } from '@tramline/contracts';
import { LABELS, type ContainerRuntime, type ManagedContainer } from './runtime';

/** Longer lines are cut, so one runaway line can't take the queue. */
export const MAX_LINE_BYTES = 16 * 1024;
/** What the agent holds while the control plane is slow or away; older lines go first. */
export const MAX_QUEUE_BYTES = 8 * 1024 * 1024;

/**
 * Follows the logs of every workload container and ships them to the control
 * plane in batches. Re-attaches after restarts without repeating lines.
 */
export class LogShipper {
	#followers = new Map<string, () => void>();
	/** Last timestamp shipped per container, so re-attaching skips what was sent. */
	#lastTs = new Map<string, string>();
	/** Exited containers whose logs have been read to the end. */
	#read = new Set<string>();
	#buffer: LogLine[] = [];
	#bytes = 0;
	/** Lines dropped per deployment since the last report of it. */
	#dropped = new Map<string, number>();

	constructor(
		private runtime: ContainerRuntime,
		private send: (lines: LogLine[]) => Promise<void>,
		private maxBatch = 1000,
		private maxQueueBytes = MAX_QUEUE_BYTES
	) {}

	/** Queues a line within the byte budget, dropping the oldest lines when it's full. */
	#enqueue(line: LogLine, front = false) {
		if (Buffer.byteLength(line.line) > MAX_LINE_BYTES) {
			line = {
				...line,
				line: Buffer.from(line.line).subarray(0, MAX_LINE_BYTES).toString() + ' …[truncated]'
			};
		}
		if (front) this.#buffer.unshift(line);
		else this.#buffer.push(line);
		this.#bytes += Buffer.byteLength(line.line);
		while (this.#bytes > this.maxQueueBytes && this.#buffer.length) {
			const old = this.#buffer.shift()!;
			this.#bytes -= Buffer.byteLength(old.line);
			this.#dropped.set(old.deploymentId, (this.#dropped.get(old.deploymentId) ?? 0) + 1);
		}
	}

	/**
	 * Attaches to new running containers, reads exited ones once (a short job,
	 * like a cron run, can finish between two passes), and detaches from
	 * removed ones.
	 */
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
		for (const name of this.#read) if (!names.has(name)) this.#read.delete(name);
		for (const container of workloads) {
			if (this.#followers.has(container.name)) continue;
			if (container.status === 'running') this.#attach(container);
			else if (container.status === 'exited' && !this.#read.has(container.name)) {
				this.#read.add(container.name);
				this.#attach(container);
			}
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
				this.#enqueue({ deploymentId, ts, stream, line });
			},
			() => this.#followers.delete(container.name)
		);
		this.#followers.set(container.name, stop);
	}

	/** Queues lines that don't come from a container, e.g. build output. */
	push(line: LogLine) {
		this.#enqueue(line);
	}

	/** How many lines are waiting, and their size; for tests and diagnostics. */
	get queued() {
		return { lines: this.#buffer.length, bytes: this.#bytes };
	}

	/**
	 * Sends buffered lines, saying first where lines were dropped. On failure
	 * the batch goes back to the front of the queue, within its byte budget.
	 */
	async flush() {
		const notes: LogLine[] = [...this.#dropped].map(([deploymentId, count]) => ({
			deploymentId,
			ts: new Date().toISOString(),
			stream: 'system',
			line: `${count} log ${count === 1 ? 'line was' : 'lines were'} dropped: the service logged faster than they could be sent`
		}));
		this.#dropped.clear();
		if (!this.#buffer.length && !notes.length) return;
		const batch = [...notes, ...this.#buffer.splice(0, this.maxBatch)];
		for (const line of batch) {
			if (!notes.includes(line)) this.#bytes -= Buffer.byteLength(line.line);
		}
		try {
			await this.send(batch);
		} catch (error) {
			for (const line of batch.filter((l) => !notes.includes(l)).reverse()) {
				this.#enqueue(line, true);
			}
			for (const note of notes) {
				const count = Number(note.line.split(' ')[0]);
				this.#dropped.set(note.deploymentId, (this.#dropped.get(note.deploymentId) ?? 0) + count);
			}
			throw error;
		}
	}

	stop() {
		for (const stop of this.#followers.values()) stop();
		this.#followers.clear();
	}
}
