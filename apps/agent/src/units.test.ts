import { describe, expect, it } from 'vitest';
import { caddyConfig } from './caddy';
import { follow, repositoryOf, withTag } from './docker';
import { LABELS } from './runtime';
import { toRunSpec } from './spec';
import { desiredContainer } from './testing';

describe('toRunSpec', () => {
	it('maps restart policies and wraps start commands in a shell', () => {
		expect(toRunSpec(desiredContainer({ restartPolicy: 'always' }), 'node_1').restart).toEqual({
			name: 'always',
			maxRetries: 0
		});
		expect(toRunSpec(desiredContainer({ restartPolicy: 'never' }), 'node_1').restart).toEqual({
			name: 'no',
			maxRetries: 0
		});
		expect(toRunSpec(desiredContainer(), 'node_1').restart).toEqual({
			name: 'on-failure',
			maxRetries: 10
		});
		expect(toRunSpec(desiredContainer({ command: 'npm start' }), 'node_1').cmd).toEqual([
			'/bin/sh',
			'-c',
			'npm start'
		]);
		expect(toRunSpec(desiredContainer(), 'node_1').cmd).toBeUndefined();
	});

	it('labels containers with a spec hash that changes with the spec', () => {
		const a = toRunSpec(desiredContainer(), 'node_1');
		expect(a.labels).toMatchObject({
			[LABELS.managed]: 'true',
			[LABELS.deployment]: 'dep_1',
			[LABELS.replica]: '0'
		});
		expect(toRunSpec(desiredContainer(), 'node_1').labels[LABELS.spec]).toBe(a.labels[LABELS.spec]);
		expect(
			toRunSpec(desiredContainer({ env: { PORT: '81' } }), 'node_1').labels[LABELS.spec]
		).not.toBe(a.labels[LABELS.spec]);
	});
});

describe('workload hardening', () => {
	it('drops privileges, limits processes and never mounts the host', () => {
		const spec = toRunSpec(
			desiredContainer({ memoryMb: 512, readOnlyRootFilesystem: true }),
			'node_1'
		);
		expect(spec.security).toEqual({
			capabilities: [
				'CHOWN',
				'DAC_OVERRIDE',
				'FOWNER',
				'FSETID',
				'KILL',
				'NET_BIND_SERVICE',
				'SETGID',
				'SETUID'
			],
			pidsLimit: 1024,
			memoryMb: 512,
			readOnlyRootFilesystem: true
		});
		expect(spec.security.capabilities).not.toContain('NET_RAW');
		expect(spec.binds).toBeUndefined();
		expect(spec.ports).toBeUndefined();
	});
});

describe('withTag', () => {
	it.each([
		['nginx', 'nginx:latest'],
		['nginx:1.27', 'nginx:1.27'],
		['localhost:5000/app', 'localhost:5000/app:latest'],
		['ghcr.io/acme/api@sha256:abc', 'ghcr.io/acme/api@sha256:abc']
	])('%s → %s', (input, expected) => expect(withTag(input)).toBe(expected));
});

describe('repositoryOf', () => {
	it.each([
		['nginx', 'nginx'],
		['nginx:1.27', 'nginx'],
		['localhost:5000/app:1', 'localhost:5000/app'],
		['localhost:5000/app', 'localhost:5000/app'],
		['ghcr.io/acme/api:1@sha256:abc', 'ghcr.io/acme/api']
	])('%s → %s', (input, expected) => expect(repositoryOf(input)).toBe(expected));
});

describe('caddyConfig', () => {
	it('routes hosts to upstreams over plain HTTP with a 404 fallback', () => {
		const config = caddyConfig({
			httpPort: 80,
			tls: false,
			routes: [
				{
					host: 'whoami-abc.localhost',
					upstreams: ['dep_1.tramline.internal:80'],
					network: 'tl-env_1'
				}
			]
		});
		const server = config.apps.http.servers.tramline;
		expect(server.listen).toEqual([':80']);
		expect(server).toHaveProperty('automatic_https', { disable: true });
		expect(server.routes[0]).toEqual({
			match: [{ host: ['whoami-abc.localhost'] }],
			handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'dep_1.tramline.internal:80' }] }],
			terminal: true
		});
		expect(server.routes.at(-1)).toMatchObject({
			handle: [{ handler: 'static_response', status_code: 404 }]
		});
	});

	it('serves HTTPS with automatic certificates and HSTS for real domains', () => {
		const server = caddyConfig({
			httpPort: 80,
			tls: true,
			routes: [
				{ host: 'api.apps.example.com', upstreams: ['dep_1.tramline.internal:80'], network: 'n' }
			]
		}).apps.http.servers.tramline;
		expect(server.listen).toEqual([':443']);
		expect(server).not.toHaveProperty('automatic_https');
		expect(server.routes[0]).toMatchObject({
			handle: [
				{
					handler: 'headers',
					response: {
						set: { 'Strict-Transport-Security': ['max-age=31536000; includeSubDomains'] }
					}
				},
				{ handler: 'reverse_proxy' }
			]
		});
	});
});

describe('follow', () => {
	const docker = (lines: object[]) =>
		({
			modem: {
				followProgress: (_: unknown, done: (e: Error | null, out: object[]) => void) =>
					done(null, lines)
			}
		}) as never;

	it('resolves when Docker reports progress only', async () => {
		await expect(
			follow(docker([{ status: 'Pulling' }, { stream: 'Loaded image: x' }]), null as never)
		).resolves.toBeUndefined();
	});

	it('rejects when Docker reports an error inside the stream', async () => {
		await expect(
			follow(
				docker([
					{ status: 'Pulling' },
					{ errorDetail: { message: 'unexpected EOF' }, error: 'unexpected EOF' }
				]),
				null as never
			)
		).rejects.toThrow('unexpected EOF');
	});
});
