import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { selfSignedCertificate, serviceCertificate } from './tls';

describe('selfSignedCertificate', () => {
	it('creates a valid, self-signed certificate for the names given', () => {
		const now = new Date('2026-10-26T12:00:00Z');
		const { cert, key } = selfSignedCertificate(
			['postgres.production.tramline.internal', 'db.example.com'],
			now
		);
		const x509 = new X509Certificate(cert);
		expect(x509.subject).toBe('CN=postgres.production.tramline.internal');
		expect(x509.issuer).toBe(x509.subject);
		expect(x509.subjectAltName).toBe(
			'DNS:postgres.production.tramline.internal, DNS:db.example.com'
		);
		expect(new Date(x509.validFrom).toISOString()).toBe('2026-10-26T12:00:00.000Z');
		expect(new Date(x509.validTo).getUTCFullYear()).toBe(2036);
		expect(x509.verify(x509.publicKey)).toBe(true);
		expect(x509.checkPrivateKey(createPrivateKey(key))).toBe(true);
		expect(createPublicKey(key).asymmetricKeyDetails).toEqual({ namedCurve: 'prime256v1' });
	});

	it('writes dates after 2049 as GeneralizedTime', () => {
		const x509 = new X509Certificate(
			selfSignedCertificate(['far.example'], new Date('2045-01-01T00:00:00Z')).cert
		);
		expect(new Date(x509.validTo).getUTCFullYear()).toBe(2054);
	});
});

describe('serviceCertificate', () => {
	it('keeps one certificate per service, with a private key only the agent can read', () => {
		const stateDir = mkdtempSync(path.join(tmpdir(), 'tl-tls-'));
		const first = serviceCertificate(stateDir, 'env_1-svc_1', ['pg.internal']);
		expect(serviceCertificate(stateDir, 'env_1-svc_1', ['pg.internal'])).toEqual(first);
		expect(serviceCertificate(stateDir, 'env_1-svc_2', ['pg.internal']).cert).not.toBe(first.cert);
		expect(statSync(path.join(stateDir, 'tls', 'env_1-svc_1', 'server.key')).mode & 0o777).toBe(
			0o600
		);
	});
});
