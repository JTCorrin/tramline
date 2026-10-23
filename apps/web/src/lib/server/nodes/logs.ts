import type { LogLine } from '@tramline/contracts';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Deployment logs: one append-only JSON-lines file per deployment, plus an
 * in-process feed for live tailing. Good enough for a single control plane;
 * a log store (e.g. VictoriaLogs) can replace it later.
 */
const live = new EventEmitter();
live.setMaxListeners(0);

const file = (dataDir: string, deploymentId: string) =>
	path.join(dataDir, 'logs', `${deploymentId.replace(/[^\w-]/g, '')}.log`);

export function appendLogs(dataDir: string, lines: LogLine[]) {
	const byDeployment = Map.groupBy(lines, (line) => line.deploymentId);
	mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
	for (const [deploymentId, group] of byDeployment) {
		appendFileSync(
			file(dataDir, deploymentId),
			group.map((l) => JSON.stringify(l) + '\n').join('')
		);
		for (const line of group) live.emit(deploymentId, line);
	}
}

/** A line written by Tramline itself, e.g. "Deployment is live". */
export function systemLog(dataDir: string, deploymentId: string, line: string) {
	appendLogs(dataDir, [{ deploymentId, ts: new Date().toISOString(), stream: 'system', line }]);
}

/** The most recent `limit` lines. */
export function readLogs(dataDir: string, deploymentId: string, limit = 1000): LogLine[] {
	let text: string;
	try {
		text = readFileSync(file(dataDir, deploymentId), 'utf8');
	} catch {
		return [];
	}
	return text
		.split('\n')
		.filter(Boolean)
		.slice(-limit)
		.map((line) => JSON.parse(line) as LogLine);
}

export function followLogs(deploymentId: string, listener: (line: LogLine) => void) {
	live.on(deploymentId, listener);
	return () => {
		live.off(deploymentId, listener);
	};
}
