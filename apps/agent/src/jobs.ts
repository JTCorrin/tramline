/**
 * A queue of long-running jobs (builds, scans, backups) that run one at a
 * time. Each job gets an AbortSignal: it fires when the job is cancelled
 * (e.g. the control plane timed it out or the deployment was removed) or
 * passes its deadline, and the job must then stop its real work, not just
 * report a failure. The queue moves on either way.
 */

export type JobState = 'queued' | 'running' | 'finished' | 'cancelled';

export class JobCancelled extends Error {}

interface Entry {
	controller: AbortController;
	state: JobState;
}

export class JobQueue {
	#tail: Promise<void> = Promise.resolve();
	#jobs = new Map<string, Entry>();

	constructor(private log: (message: string) => void = () => {}) {}

	/** Jobs queued or running, by id. */
	get active() {
		return [...this.#jobs].filter(([, e]) => e.state === 'queued' || e.state === 'running');
	}

	state(id: string): JobState | undefined {
		return this.#jobs.get(id)?.state;
	}

	has(id: string) {
		const state = this.state(id);
		return state === 'queued' || state === 'running';
	}

	/**
	 * Queues `run`. It's skipped if cancelled while waiting; otherwise its
	 * signal aborts on cancel or after `deadlineMs`. `done` gets its result,
	 * or the error it failed with (a JobCancelled when it was stopped).
	 */
	add<T>(
		id: string,
		run: (signal: AbortSignal) => Promise<T>,
		options: { deadlineMs: number; done: (result: T | Error) => void }
	) {
		if (this.has(id)) return;
		const entry: Entry = { controller: new AbortController(), state: 'queued' };
		this.#jobs.set(id, entry);
		this.#tail = this.#tail.then(async () => {
			if (entry.state === 'cancelled') return;
			entry.state = 'running';
			const timer = setTimeout(
				() =>
					entry.controller.abort(
						new JobCancelled(`Timed out after ${Math.round(options.deadlineMs / 60_000)} minutes`)
					),
				options.deadlineMs
			);
			timer.unref?.();
			let result: T | Error;
			try {
				result = await run(entry.controller.signal);
			} catch (error) {
				result = error instanceof Error ? error : new Error(String(error));
			} finally {
				clearTimeout(timer);
			}
			if (entry.controller.signal.aborted && !(result instanceof JobCancelled)) {
				const reason = entry.controller.signal.reason;
				result = reason instanceof JobCancelled ? reason : new JobCancelled('Cancelled');
			}
			entry.state = entry.controller.signal.aborted ? 'cancelled' : 'finished';
			try {
				options.done(result);
			} catch (error) {
				this.log(`job ${id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	}

	/** Stops a job: a queued one never starts, a running one gets its signal aborted. */
	cancel(id: string, reason = 'Cancelled') {
		const entry = this.#jobs.get(id);
		if (!entry || entry.state === 'finished' || entry.state === 'cancelled') return;
		if (entry.state === 'queued') entry.state = 'cancelled';
		entry.controller.abort(new JobCancelled(reason));
	}

	/** Forgets finished and cancelled jobs, so their ids can be queued again. */
	forget(id: string) {
		const state = this.state(id);
		if (state === 'finished' || state === 'cancelled') this.#jobs.delete(id);
	}

	/** Resolves when everything queued so far has run. */
	idle() {
		return this.#tail;
	}
}
