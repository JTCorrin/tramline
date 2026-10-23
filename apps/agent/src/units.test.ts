import { describe, expect, it } from 'vitest';
import { caddyConfig } from './caddy';
import { withTag } from './docker';
import { LABELS } from './runtime';
import { toRunSpec } from './spec';
import { desiredContainer } from './testing';

describe('toRunSpec', () => {
	it('maps restart policies and wraps start commands in a shell', () => {
		expect(toRunSpec(desiredContainer({ restartPolicy: 'always' })).restart).toEqual({
			name: 'always',
			maxRetries: 0
		});
		expect(toRunSpec(desiredContainer({ restartPolicy: 'never' })).restart).toEqual({
			name: 'no',
			maxRetries: 0
		});
		expect(toRunSpec(desiredContainer()).restart).toEqual({ name: 'on-failure', maxRetries: 10 });
		expect(toRunSpec(desiredContainer({ command: 'npm start' })).cmd).toEqual([
			'/bin/sh',
			'-c',
			'npm start'
		]);
		expect(toRunSpec(desiredContainer()).cmd).toBeUndefined();
	});

	it('labels containers with a spec hash that changes with the spec', () => {
		const a = toRunSpec(desiredContainer());
		expect(a.labels).toMatchObject({
			[LABELS.managed]: 'true',
			[LABELS.deployment]: 'dep_1',
			[LABELS.replica]: '0'
		});
		expect(toRunSpec(desiredContainer()).labels[LABELS.spec]).toBe(a.labels[LABELS.spec]);
		expect(toRunSpec(desiredContainer({ env: { PORT: '81' } })).labels[LABELS.spec]).not.toBe(
			a.labels[LABELS.spec]
		);
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

	it('serves HTTPS with automatic certificates for real domains', () => {
		const server = caddyConfig({ httpPort: 80, tls: true, routes: [] }).apps.http.servers.tramline;
		expect(server.listen).toEqual([':443']);
		expect(server).not.toHaveProperty('automatic_https');
	});
});
