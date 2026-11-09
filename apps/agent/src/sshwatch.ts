import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isIP } from 'node:net';

/**
 * Failed SSH logins on the node (`agent.mjs sshwatch`). A container of the
 * agent's own image, with the host's /var/log mounted read-only, no network
 * and no capabilities, follows sshd's lines in the auth log and prints a
 * JSON line per failed connection, which the agent reads like the ingress's
 * access log.
 *
 * One line per connection (sshd's process ID), whatever it tried: a bot
 * guessing six passwords on one connection is one failed login, and so is
 * a key-only server's "Invalid user admin", then "Connection closed".
 *
 * Ubuntu, Debian with rsyslog, and RHEL-style systems write these files;
 * a system that only has the systemd journal reports itself unavailable.
 */

export const sshWatchName = (nodeId: string) => `tramline-sshwatch-${nodeId}`;

/** Where the host's /var/log is mounted in the container. */
export const HOST_LOG_DIR = '/host/log';
export const SSH_LOGS = ['auth.log', 'secure'];

export interface SshFailure {
	ts: string;
	pid: string;
	client: string;
	user: string | null;
}

const PREFIX = /sshd(?:-session)?\[(\d+)\]:\s+(.*)$/;
const PATTERNS = [
	/^Failed \S+ for (?:invalid user )?(\S*) from (\S+) port \d+/,
	/^Invalid user (\S*) from (\S+) port \d+/,
	/^(?:Connection closed|Disconnected) (?:by|from) (?:invalid|authenticating) user (\S*) (\S+) port \d+/,
	/^error: maximum authentication attempts exceeded for (?:invalid user )?(\S*) from (\S+) port \d+/
];
const ISO = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d))\s/;

/** A failed login in one line of the auth log; null for anything else. */
export function parseAuthLine(line: string, now = () => new Date()): SshFailure | null {
	const match = PREFIX.exec(line);
	if (!match) return null;
	const [, pid, message] = match;
	for (const pattern of PATTERNS) {
		const found = pattern.exec(message!);
		if (!found) continue;
		const client = found[2]!;
		if (!isIP(client)) return null;
		const iso = ISO.exec(line)?.[1];
		const ts = iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso) : now();
		return {
			ts: ts.toISOString(),
			pid: pid!,
			client,
			user: found[1] ? found[1].slice(0, 64) : null
		};
	}
	return null;
}

/** Process IDs are remembered this long, so one connection's lines count once. */
const PID_MEMORY_MS = 10 * 60_000;
const MAX_READ = 1024 * 1024;

/**
 * Follows the auth log from its end: past failures aren't replayed when the
 * watcher starts. A rotated or truncated file is read again from the start.
 */
export class AuthLogFollower {
	#state: 'starting' | 'watching' | 'unavailable' = 'starting';
	#file: string | null = null;
	#inode = 0;
	#offset = 0;
	#mtime = 0;
	#partial = '';
	#pids = new Map<string, number>();

	constructor(
		private dir: string,
		private emit: (line: string) => void,
		private now: () => number = Date.now
	) {}

	/** The file being followed, or null when there's none. */
	get file() {
		return this.#file;
	}

	/** The first auth log that opens; checked and read through that one handle. */
	#open() {
		for (const name of SSH_LOGS) {
			const file = `${this.dir}/${name}`;
			try {
				return { file, fd: openSync(file, 'r') };
			} catch {
				// not there; try the next
			}
		}
		return null;
	}

	/** Reads what was appended since the last poll. */
	poll() {
		const opened = this.#open();
		if (!opened) {
			if (this.#state !== 'unavailable') {
				this.#state = 'unavailable';
				this.#file = null;
				this.emit(JSON.stringify({ ssh: 'unavailable', looked: SSH_LOGS }));
			}
			return;
		}
		const { file, fd } = opened;
		try {
			this.#read(file, fd);
		} finally {
			closeSync(fd);
		}
	}

	#read(file: string, fd: number) {
		const stat = fstatSync(fd);
		if (file !== this.#file || stat.ino !== this.#inode) {
			// the first file is read from its end; one that replaced it (a rotation) from the start
			this.#offset = this.#state === 'starting' ? stat.size : 0;
			if (this.#state !== 'watching') {
				this.emit(JSON.stringify({ ssh: 'watching', file: file.split('/').pop() }));
			}
			this.#state = 'watching';
			this.#file = file;
			this.#inode = stat.ino;
			this.#partial = '';
		}
		// truncated in place: shorter than where we were, or written to without growing past it
		if (stat.size < this.#offset || (stat.size === this.#offset && stat.mtimeMs !== this.#mtime)) {
			if (this.#mtime) {
				this.#offset = 0;
				this.#partial = '';
			}
		}
		this.#mtime = stat.mtimeMs;
		if (stat.size === this.#offset) return;
		const length = Math.min(stat.size - this.#offset, MAX_READ);
		const buffer = Buffer.alloc(length);
		const read = readSync(fd, buffer, 0, length, this.#offset);
		this.#offset += read;
		const text = this.#partial + buffer.subarray(0, read).toString('utf8');
		const lines = text.split('\n');
		this.#partial = lines.pop() ?? '';
		for (const line of lines) this.#line(line);
	}

	#line(line: string) {
		const failure = parseAuthLine(line, () => new Date(this.now()));
		if (!failure) return;
		const now = this.now();
		for (const [pid, seen] of this.#pids) if (now - seen > PID_MEMORY_MS) this.#pids.delete(pid);
		if (this.#pids.has(failure.pid)) return;
		this.#pids.set(failure.pid, now);
		this.emit(
			JSON.stringify({ ssh: 'failed', ts: failure.ts, client: failure.client, user: failure.user })
		);
	}
}

export async function runSshWatch(dir = HOST_LOG_DIR) {
	const follower = new AuthLogFollower(dir, (line) => console.log(line));
	for (;;) {
		try {
			follower.poll();
		} catch (error) {
			console.error(`[sshwatch] ${error instanceof Error ? error.message : String(error)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}
