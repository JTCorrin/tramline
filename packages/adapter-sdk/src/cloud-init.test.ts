import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloudInit } from './cloud-init';

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
				command('curl', 'echo enroll >> "$CALLS"');
				symlinkSync('/bin/sh', path.join(dir, 'sh'));
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
