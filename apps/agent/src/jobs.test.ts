import { describe, expect, it } from 'vitest';
import { JobCancelled, JobQueue } from './jobs';

const deferred = () => {
	let resolve!: (value: string) => void;
	const promise = new Promise<string>((r) => (resolve = r));
	return { promise, resolve };
};

describe('JobQueue', () => {
	it('runs jobs one at a time, in order', async () => {
		const queue = new JobQueue();
		const order: string[] = [];
		const first = deferred();
		const results: (string | Error)[] = [];
		queue.add(
			'a',
			async () => {
				order.push('a starts');
				return first.promise;
			},
			{ deadlineMs: 1000, done: (r) => results.push(r as string) }
		);
		queue.add(
			'b',
			async () => {
				order.push('b starts');
				return 'b';
			},
			{ deadlineMs: 1000, done: (r) => results.push(r as string) }
		);
		await Promise.resolve();
		expect(queue.state('b')).toBe('queued');
		first.resolve('a');
		await queue.idle();
		expect(order).toEqual(['a starts', 'b starts']);
		expect(results).toEqual(['a', 'b']);
		expect(queue.state('a')).toBe('finished');
	});

	it('aborts a job at its deadline, and moves on', async () => {
		const queue = new JobQueue();
		let result: unknown;
		queue.add(
			'slow',
			(signal) =>
				new Promise((_, reject) =>
					signal.addEventListener('abort', () => reject(new Error('builder removed')))
				),
			{ deadlineMs: 5, done: (r) => (result = r) }
		);
		await queue.idle();
		expect(result).toBeInstanceOf(JobCancelled);
		expect((result as Error).message).toBe('Timed out after 0 minutes');
		expect(queue.state('slow')).toBe('cancelled');
	});

	it('cancels a running job through its signal, and a queued one before it starts', async () => {
		const queue = new JobQueue();
		const results = new Map<string, unknown>();
		let started = false;
		queue.add(
			'running',
			(signal) =>
				new Promise((resolve) => signal.addEventListener('abort', () => resolve('cleaned up'))),
			{ deadlineMs: 60_000, done: (r) => results.set('running', r) }
		);
		queue.add(
			'queued',
			async () => {
				started = true;
				return 'ran';
			},
			{ deadlineMs: 60_000, done: (r) => results.set('queued', r) }
		);
		await Promise.resolve();
		queue.cancel('queued');
		queue.cancel('running', 'No longer wanted');
		await queue.idle();
		expect(started).toBe(false);
		// a job that stops cleanly after being cancelled still counts as cancelled
		expect(results.get('running')).toBeInstanceOf(JobCancelled);
		expect((results.get('running') as Error).message).toBe('No longer wanted');
		expect(results.has('queued')).toBe(false);
		expect(queue.active).toEqual([]);

		// forgotten, an id can be queued again
		queue.forget('running');
		queue.add('running', async () => 'again', {
			deadlineMs: 1000,
			done: (r) => results.set('running', r)
		});
		await queue.idle();
		expect(results.get('running')).toBe('again');
	});

	it('reports a job that throws, and survives a failing done callback', async () => {
		const logs: string[] = [];
		const queue = new JobQueue((line) => logs.push(line));
		let result: unknown;
		queue.add(
			'bad',
			async () => {
				throw new Error('boom');
			},
			{
				deadlineMs: 1000,
				done: (r) => {
					result = r;
					throw new Error('done failed');
				}
			}
		);
		queue.add('next', async () => 'fine', { deadlineMs: 1000, done: () => {} });
		await queue.idle();
		expect((result as Error).message).toBe('boom');
		expect(logs).toEqual(['job bad: done failed']);
		expect(queue.state('next')).toBe('finished');
		// adding an id that's still active does nothing
		let runs = 0;
		const twice = () => queue.add('once', async () => ++runs, { deadlineMs: 1000, done: () => {} });
		twice();
		twice();
		await queue.idle();
		expect(runs).toBe(1);
	});
});
