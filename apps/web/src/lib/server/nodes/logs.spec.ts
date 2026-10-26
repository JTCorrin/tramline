import type { LogLine } from '@tramline/contracts';
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendLogs, MAX_LINE_BYTES, pruneLogs, readLogs } from './logs';

const line = (n: number, text = `line ${n}`): LogLine => ({
	deploymentId: 'dep_1',
	ts: new Date(1_800_000_000_000 + n).toISOString(),
	stream: 'stdout',
	line: text
});

describe('deployment logs', () => {
	it('tails a large log from its end', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'tl-logs-'));
		appendLogs(
			dir,
			Array.from({ length: 50_000 }, (_, n) => line(n))
		);
		const tail = readLogs(dir, 'dep_1', 3);
		expect(tail.map((l) => l.line)).toEqual(['line 49997', 'line 49998', 'line 49999']);
		expect(readLogs(dir, 'dep_missing')).toEqual([]);
	});

	it('rotates a file past its size limit, keeping one previous file', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'tl-logs-'));
		appendLogs(
			dir,
			Array.from({ length: 100 }, (_, n) => line(n)),
			1000
		);
		appendLogs(dir, [line(100)], 1000);
		expect(existsSync(path.join(dir, 'logs', 'dep_1.log.1'))).toBe(true);
		expect(readLogs(dir, 'dep_1').map((l) => l.line)).toEqual(['line 100']);
	});

	it('cuts runaway lines, and skips a corrupt one', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'tl-logs-'));
		appendLogs(dir, [line(1, 'x'.repeat(MAX_LINE_BYTES * 2))]);
		writeFileSync(path.join(dir, 'logs', 'dep_1.log'), 'not json\n', { flag: 'a' });
		appendLogs(dir, [line(2)]);
		const lines = readLogs(dir, 'dep_1');
		expect(lines).toHaveLength(2);
		expect(lines[0]!.line.endsWith('…[truncated]')).toBe(true);
	});

	it('deletes logs nothing has written to for a month', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'tl-logs-'));
		appendLogs(dir, [line(1), { ...line(2), deploymentId: 'dep_2' }]);
		const old = new Date(Date.now() - 40 * 24 * 3600_000);
		utimesSync(path.join(dir, 'logs', 'dep_1.log'), old, old);
		expect(pruneLogs(dir)).toBe(1);
		expect(readLogs(dir, 'dep_1')).toEqual([]);
		expect(readLogs(dir, 'dep_2')).toHaveLength(1);
		expect(pruneLogs(path.join(dir, 'nowhere'))).toBe(0);
	});
});
