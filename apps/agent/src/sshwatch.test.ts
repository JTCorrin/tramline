import {
	appendFileSync,
	mkdtempSync,
	renameSync,
	rmSync,
	truncateSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthLogFollower, parseAuthLine } from './sshwatch';

const T = '2027-01-15T08:00:00.123456+00:00';
const line = (pid: number, message: string, ts = T) => `${ts} node-1 sshd[${pid}]: ${message}`;

describe('reading the auth log', () => {
	it('finds failed logins, whatever was tried', () => {
		const cases: [string, string | null, string][] = [
			['Failed password for root from 203.0.113.9 port 51234 ssh2', 'root', '203.0.113.9'],
			[
				'Failed password for invalid user admin from 203.0.113.9 port 1 ssh2',
				'admin',
				'203.0.113.9'
			],
			['Failed publickey for deploy from 2001:db8::1 port 2 ssh2', 'deploy', '2001:db8::1'],
			['Invalid user oracle from 198.51.100.7 port 3', 'oracle', '198.51.100.7'],
			['Connection closed by invalid user pi 198.51.100.7 port 4 [preauth]', 'pi', '198.51.100.7'],
			[
				'Connection closed by authenticating user root 198.51.100.7 port 5 [preauth]',
				'root',
				'198.51.100.7'
			],
			[
				'Disconnected from authenticating user root 198.51.100.7 port 6 [preauth]',
				'root',
				'198.51.100.7'
			],
			[
				'error: maximum authentication attempts exceeded for root from 198.51.100.7 port 7 ssh2 [preauth]',
				'root',
				'198.51.100.7'
			],
			['Invalid user  from 198.51.100.7 port 8', null, '198.51.100.7']
		];
		for (const [message, user, client] of cases) {
			expect(parseAuthLine(line(10, message)), message).toEqual({
				ts: '2027-01-15T08:00:00.123Z',
				pid: '10',
				client,
				user
			});
		}
	});

	it('ignores successes, other programs and connections that never tried', () => {
		for (const text of [
			line(1, 'Accepted publickey for deploy from 203.0.113.9 port 1 ssh2: ED25519 SHA256:x'),
			line(1, 'Connection closed by 203.0.113.9 port 1 [preauth]'),
			line(1, 'Invalid user admin from not-an-address port 1'),
			`${T} node-1 sudo[1]: Failed password for root from 203.0.113.9 port 1 ssh2`,
			'garbage'
		]) {
			expect(parseAuthLine(text), text).toBeNull();
		}
	});

	it("reads OpenSSH 9.8's sshd-session, and the classic syslog format at the time it's read", () => {
		const now = new Date('2027-01-15T09:00:00Z');
		expect(
			parseAuthLine(
				'Jan 15 09:00:00 node-1 sshd-session[42]: Invalid user x from 203.0.113.9 port 1',
				() => now
			)
		).toMatchObject({ pid: '42', ts: now.toISOString() });
	});
});

describe('following the auth log', () => {
	const setup = (file = 'auth.log') => {
		const dir = mkdtempSync(path.join(tmpdir(), 'tramline-ssh-'));
		const out: Record<string, unknown>[] = [];
		const follower = new AuthLogFollower(
			dir,
			(l) => out.push(JSON.parse(l)),
			() => Date.parse(T)
		);
		return { dir, file: path.join(dir, file), out, follower };
	};
	const failed = (out: Record<string, unknown>[]) => out.filter((o) => o.ssh === 'failed');

	it('starts at the end, then reports each new failed connection once', () => {
		const { file, out, follower } = setup();
		writeFileSync(file, line(1, 'Invalid user old from 203.0.113.1 port 1') + '\n');
		follower.poll();
		expect(out).toEqual([{ ssh: 'watching', file: 'auth.log' }]);
		expect(follower.file).toBe(file);

		appendFileSync(
			file,
			[
				line(2, 'Invalid user admin from 203.0.113.9 port 1'),
				line(2, 'Failed password for invalid user admin from 203.0.113.9 port 1 ssh2'),
				line(2, 'Connection closed by invalid user admin 203.0.113.9 port 1 [preauth]'),
				line(3, 'Failed password for root from 198.51.100.7 port 2 ssh2')
			].join('\n') + '\n'
		);
		follower.poll();
		expect(failed(out)).toEqual([
			{ ssh: 'failed', ts: '2027-01-15T08:00:00.123Z', client: '203.0.113.9', user: 'admin' },
			{ ssh: 'failed', ts: '2027-01-15T08:00:00.123Z', client: '198.51.100.7', user: 'root' }
		]);
		follower.poll();
		expect(failed(out)).toHaveLength(2);
	});

	it('waits for a line to be finished', () => {
		const { file, out, follower } = setup();
		writeFileSync(file, '');
		follower.poll();
		const text = line(4, 'Invalid user admin from 203.0.113.9 port 1');
		appendFileSync(file, text.slice(0, 20));
		follower.poll();
		expect(failed(out)).toHaveLength(0);
		appendFileSync(file, text.slice(20) + '\n');
		follower.poll();
		expect(failed(out)).toHaveLength(1);
	});

	it('reads a rotated or truncated log from the start', () => {
		const { file, out, follower } = setup();
		writeFileSync(file, '');
		follower.poll();
		renameSync(file, `${file}.1`);
		writeFileSync(file, line(5, 'Invalid user a from 203.0.113.9 port 1') + '\n');
		follower.poll();
		expect(failed(out)).toHaveLength(1);
		truncateSync(file, 0);
		appendFileSync(file, line(6, 'Invalid user b from 203.0.113.9 port 1') + '\n');
		follower.poll();
		expect(failed(out).map((o) => o.user)).toEqual(['a', 'b']);
	});

	it('says when there is no auth log, and picks one up when it appears', () => {
		const { file, out, follower } = setup('secure');
		follower.poll();
		follower.poll();
		expect(out).toEqual([{ ssh: 'unavailable', looked: ['auth.log', 'secure'] }]);
		expect(follower.file).toBeNull();
		writeFileSync(file, line(7, 'Invalid user c from 203.0.113.9 port 1') + '\n');
		follower.poll();
		// a log that appears later is read whole: nothing in it was seen before
		expect(out.slice(1)).toEqual([
			{ ssh: 'watching', file: 'secure' },
			{ ssh: 'failed', ts: '2027-01-15T08:00:00.123Z', client: '203.0.113.9', user: 'c' }
		]);
		rmSync(file);
		follower.poll();
		expect(out.at(-1)).toEqual({ ssh: 'unavailable', looked: ['auth.log', 'secure'] });
	});
});
