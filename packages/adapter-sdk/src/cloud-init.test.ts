import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloudInit, ENROLL_ATTEMPTS } from './cloud-init';

describe('guest agent setup', () => {
	it.each([0, 1])(
		'starts a preinstalled agent and still enrolls when start exits %i',
		(exitCode) => {
			const dir = mkdtempSync(path.join(tmpdir(), 'tramline-guest-'));
			try {
				const channel = path.join(dir, 'channel');
				const log = path.join(dir, 'calls');
				writeFileSync(channel, '');
				const command = (name: string, body: string) =>
					writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
				command('docker', 'exit 0');
				command('qemu-ga', 'exit 0');
				command('apt-get', 'echo unexpected-install >> "$CALLS"; exit 1');
				command('dnf', 'echo unexpected-install >> "$CALLS"; exit 1');
				command(
					'systemctl',
					`echo "$*" >> "$CALLS"; if [ "$1" = start ]; then exit ${exitCode}; fi`
				);
				command('curl', 'exit 0');
				command('sh', 'echo enroll >> "$CALLS"');
				const userData = cloudInit({ url: 'https://tramline.test', token: 'join-token' });
				const script = userData
					.split('\n')
					.filter((line) => line.startsWith('      '))
					.map((line) => line.slice(6))
					.join('\n')
					.replace('/dev/virtio-ports/org.qemu.guest_agent.0', channel);
				execFileSync('/bin/sh', ['-c', script], { env: { PATH: dir, CALLS: log }, stdio: 'pipe' });
				expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
					'enable --now docker',
					'start qemu-guest-agent',
					'enroll'
				]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	);
});

describe('mesh endpoint', () => {
	function enroll(publicAddress: string) {
		const dir = mkdtempSync(path.join(tmpdir(), 'tramline-endpoint-'));
		try {
			const log = path.join(dir, 'calls');
			const command = (name: string, body: string) =>
				writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
			command('docker', 'exit 0');
			command('systemctl', 'exit 0');
			command('curl', 'exit 0');
			command('metadata', 'echo 203.0.113.9');
			command('broken', 'exit 7');
			// what the install script is run with
			command('sh', 'echo "$*" >> "$CALLS"');
			const script = cloudInit({ url: 'https://tramline.test', token: 'jt', publicAddress })
				.split('\n')
				.filter((line) => line.startsWith('      '))
				.map((line) => line.slice(6))
				.join('\n');
			execFileSync('/bin/sh', ['-c', script], {
				env: { PATH: dir, CALLS: log },
				stdio: 'pipe'
			});
			return readFileSync(log, 'utf8').trim();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it('offers the address the command prints as the mesh endpoint', () => {
		expect(enroll('metadata')).toBe(
			'/run/tramline-install.sh --url https://tramline.test --token jt --endpoint 203.0.113.9:51820'
		);
	});

	it('still enrolls without an endpoint when the command fails', () => {
		expect(enroll('broken')).toBe(
			'/run/tramline-install.sh --url https://tramline.test --token jt'
		);
	});
});

describe('enrolling', () => {
	/** Runs the enroll script with curl failing its first `failures` calls. */
	function enroll(failures: number) {
		const dir = mkdtempSync(path.join(tmpdir(), 'tramline-retry-'));
		try {
			const log = path.join(dir, 'calls');
			const count = path.join(dir, 'count');
			writeFileSync(count, '0');
			writeFileSync(log, '');
			const command = (name: string, body: string) =>
				writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
			command('docker', 'exit 0');
			command('systemctl', 'exit 0');
			command('cat', `exec /bin/cat "$@"`);
			command(
				'curl',
				`n=$(cat "${count}"); echo $((n + 1)) > "${count}"; [ "$n" -ge ${failures} ] || exit 7`
			);
			command('sleep', 'echo "sleep $*" >> "$CALLS"');
			command('sh', 'echo enroll >> "$CALLS"');
			const script = cloudInit({ url: 'https://tramline.test', token: 'jt' })
				.split('\n')
				.filter((line) => line.startsWith('      '))
				.map((line) => line.slice(6))
				.join('\n');
			let status = 0;
			let stderr = '';
			try {
				execFileSync('/bin/sh', ['-c', script], { env: { PATH: dir, CALLS: log }, stdio: 'pipe' });
			} catch (error) {
				const failed = error as { status: number; stderr: Buffer };
				status = failed.status;
				stderr = failed.stderr.toString();
			}
			return {
				status,
				stderr,
				calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
			};
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it('keeps trying while Tramline is unreachable, then enrolls', () => {
		const { status, calls } = enroll(2);
		expect(status).toBe(0);
		expect(calls).toEqual(['sleep 15', 'sleep 15', 'enroll']);
	});

	it('gives up after its attempts, saying why', () => {
		const { status, stderr, calls } = enroll(1_000_000);
		expect(status).toBe(1);
		expect(calls).toHaveLength(ENROLL_ATTEMPTS - 1);
		expect(calls.every((call) => call === 'sleep 15')).toBe(true);
		expect(stderr).toContain(`couldn't enroll after ${ENROLL_ATTEMPTS} attempts`);
	});
});
