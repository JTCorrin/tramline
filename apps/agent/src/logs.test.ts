import type { LogLine } from '@tramline/contracts';
import { describe, expect, it, vi } from 'vitest';
import { LogShipper, MAX_LINE_BYTES } from './logs';
import { FakeRuntime } from './testing';

const line = (n: number, size = 10): LogLine => ({
	deploymentId: n % 2 ? 'dep_odd' : 'dep_even',
	ts: new Date(1_800_000_000_000 + n).toISOString(),
	stream: 'stdout',
	line: String(n).padEnd(size, '.')
});

describe('LogShipper', () => {
	it('keeps within its byte budget by dropping the oldest lines, then says so', async () => {
		const sent: LogLine[][] = [];
		const shipper = new LogShipper(
			new FakeRuntime(),
			async (batch) => void sent.push(batch),
			100,
			100
		);
		for (let n = 0; n < 30; n++) shipper.push(line(n));
		expect(shipper.queued.bytes).toBeLessThanOrEqual(100);
		expect(shipper.queued.lines).toBe(10);

		await shipper.flush();
		const [batch] = sent;
		const notes = batch!.filter((l) => l.stream === 'system');
		expect(notes.map((n) => [n.deploymentId, n.line]).sort()).toEqual([
			['dep_even', '10 log lines were dropped: the service logged faster than they could be sent'],
			['dep_odd', '10 log lines were dropped: the service logged faster than they could be sent']
		]);
		// the newest lines are the ones kept
		expect(batch!.filter((l) => l.stream === 'stdout').map((l) => l.line.split('.')[0])).toEqual(
			Array.from({ length: 10 }, (_, i) => String(20 + i))
		);
		expect(shipper.queued).toEqual({ lines: 0, bytes: 0 });
	});

	it('cuts runaway lines', () => {
		const shipper = new LogShipper(new FakeRuntime(), async () => {});
		shipper.push(line(1, MAX_LINE_BYTES * 3));
		expect(shipper.queued.bytes).toBeLessThan(MAX_LINE_BYTES + 32);
	});

	it('puts a failed batch back, notes included, and stays within budget', async () => {
		const send = vi.fn<(lines: LogLine[]) => Promise<void>>(async () => {
			throw new Error('control plane away');
		});
		const shipper = new LogShipper(new FakeRuntime(), send, 5, 50);
		for (let n = 0; n < 10; n++) shipper.push(line(n));
		await expect(shipper.flush()).rejects.toThrow('away');
		expect(shipper.queued.bytes).toBeLessThanOrEqual(50);

		send.mockResolvedValue(undefined);
		await shipper.flush();
		const delivered = send.mock.calls.at(-1)![0];
		// the drop notes survive a failed send
		expect(delivered.filter((l) => l.stream === 'system').length).toBeGreaterThan(0);
	});
});
