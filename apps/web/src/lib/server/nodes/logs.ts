import type { LogLine } from '@tramline/contracts';
import { EventEmitter } from 'node:events';
import {
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	writeSync
} from 'node:fs';
import path from 'node:path';

/**
 * Deployment logs: one append-only JSON-lines file per deployment, plus an
 * in-process feed for live tailing. Files rotate at MAX_FILE_BYTES (one
 * previous file is kept) and are deleted MAX_AGE_MS after they were last
 * written. Good enough for a single control plane; a log store (e.g.
 * VictoriaLogs) can replace it later.
 */
const live = new EventEmitter();
live.setMaxListeners(0);

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_LINE_BYTES = 16 * 1024;
export const MAX_AGE_MS = 30 * 24 * 3600_000;
/** How much of the end of a file a tail read looks at, at most. */
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

const file = (dataDir: string, deploymentId: string) =>
	path.join(dataDir, 'logs', `${deploymentId.replace(/[^\w-]/g, '')}.log`);

const clip = (line: LogLine): LogLine =>
	Buffer.byteLength(line.line) > MAX_LINE_BYTES
		? {
				...line,
				line: Buffer.from(line.line).subarray(0, MAX_LINE_BYTES).toString() + ' …[truncated]'
			}
		: line;

export function appendLogs(dataDir: string, lines: LogLine[], maxFileBytes = MAX_FILE_BYTES) {
	const byDeployment = Map.groupBy(lines.map(clip), (line) => line.deploymentId);
	mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
	for (const [deploymentId, group] of byDeployment) {
		const target = file(dataDir, deploymentId);
		// append, then rotate once the file is over the limit: the size checked is the size of
		// the file just written, through the same handle
		const fd = openSync(target, 'a');
		let size: number;
		try {
			writeSync(fd, group.map((l) => JSON.stringify(l) + '\n').join(''));
			size = fstatSync(fd).size;
		} finally {
			closeSync(fd);
		}
		if (size >= maxFileBytes) renameSync(target, `${target}.1`);
		for (const line of group) live.emit(deploymentId, line);
	}
}

/** A line written by Tramline itself, e.g. "Deployment is live". */
export function systemLog(dataDir: string, deploymentId: string, line: string) {
	appendLogs(dataDir, [{ deploymentId, ts: new Date().toISOString(), stream: 'system', line }]);
}

/**
 * The most recent `limit` lines, read from the end of the file: a short tail
 * of a large log never reads the whole of it.
 */
export function readLogs(dataDir: string, deploymentId: string, limit = 1000): LogLine[] {
	let fd: number;
	try {
		fd = openSync(file(dataDir, deploymentId), 'r');
	} catch {
		return [];
	}
	try {
		const { size } = fstatSync(fd);
		const length = Math.min(size, MAX_TAIL_BYTES, Math.max(64 * 1024, limit * 2048));
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		const lines = buffer.toString('utf8').split('\n');
		// the first line is cut unless the read started at the beginning
		if (length < size) lines.shift();
		return lines
			.filter(Boolean)
			.slice(-limit)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as LogLine];
				} catch {
					return [];
				}
			});
	} finally {
		closeSync(fd);
	}
}

/** Deletes log files nothing has written to for `maxAgeMs`. */
export function pruneLogs(dataDir: string, now = Date.now(), maxAgeMs = MAX_AGE_MS) {
	const dir = path.join(dataDir, 'logs');
	let removed = 0;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return 0;
	}
	for (const name of names) {
		const full = path.join(dir, name);
		try {
			const fd = openSync(full, 'r');
			let mtimeMs: number;
			try {
				mtimeMs = fstatSync(fd).mtimeMs;
			} finally {
				closeSync(fd);
			}
			if (now - mtimeMs > maxAgeMs) {
				rmSync(full, { force: true });
				removed++;
			}
		} catch {
			// gone already
		}
	}
	return removed;
}

export function followLogs(deploymentId: string, listener: (line: LogLine) => void) {
	live.on(deploymentId, listener);
	return () => {
		live.off(deploymentId, listener);
	};
}
