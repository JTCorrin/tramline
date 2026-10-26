import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A self-signed ECDSA P-256 certificate for a database's TLS. The key is
 * created on the node and never leaves it. Clients connect with
 * `sslmode=require` (encrypted); the certificate's SHA-256 fingerprint is
 * stable across deploys so it can be pinned.
 *
 * Node can parse certificates but not create them, and a library for one
 * self-signed certificate isn't worth its dependencies, so this writes the
 * DER by hand. X509Certificate in the tests checks the result.
 */

const der = (tag: number, ...content: Buffer[]) => {
	const body = Buffer.concat(content);
	const length =
		body.length < 0x80
			? Buffer.from([body.length])
			: (() => {
					const bytes: number[] = [];
					for (let n = body.length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
					return Buffer.from([0x80 | bytes.length, ...bytes]);
				})();
	return Buffer.concat([Buffer.from([tag]), length, body]);
};
const seq = (...items: Buffer[]) => der(0x30, ...items);
const set = (...items: Buffer[]) => der(0x31, ...items);
const oid = (dotted: string) => {
	const [a, b, ...rest] = dotted.split('.').map(Number);
	const bytes = [a! * 40 + b!];
	for (const n of rest) {
		const chunk: number[] = [n & 0x7f];
		for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
		bytes.push(...chunk);
	}
	return der(0x06, Buffer.from(bytes));
};
const integer = (bytes: Buffer) =>
	der(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
/** UTCTime until 2049, GeneralizedTime after, as RFC 5280 requires. */
const time = (date: Date) => {
	const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
	return date.getUTCFullYear() < 2050
		? der(0x17, Buffer.from(iso.slice(2)))
		: der(0x18, Buffer.from(iso));
};
const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn)))));

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

export interface Certificate {
	/** PEM */
	cert: string;
	/** PKCS#8 PEM */
	key: string;
}

/** Creates a certificate for `names` (the first is the common name), valid for ten years. */
export function selfSignedCertificate(names: string[], now = new Date()): Certificate {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const spki = publicKey.export({ format: 'der', type: 'spki' });
	const notAfter = new Date(now.getTime() + 10 * 365 * 86_400_000);
	const altNames = seq(...names.map((n) => der(0x82, Buffer.from(n))));
	const tbs = seq(
		der(0xa0, integer(Buffer.from([2]))),
		integer(randomBytes(16)),
		ECDSA_SHA256,
		name(names[0]!),
		seq(time(now), time(notAfter)),
		name(names[0]!),
		spki,
		der(0xa3, seq(seq(oid('2.5.29.17'), der(0x04, altNames))))
	);
	const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
	const certificate = seq(
		tbs,
		ECDSA_SHA256,
		der(0x03, Buffer.concat([Buffer.from([0]), signature]))
	);
	const pem = (label: string, body: Buffer) =>
		`-----BEGIN ${label}-----\n${body
			.toString('base64')
			.match(/.{1,64}/g)!
			.join('\n')}\n-----END ${label}-----\n`;
	return {
		cert: pem('CERTIFICATE', certificate),
		key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
	};
}

/**
 * The certificate for one service, created on first use and kept in the
 * agent's state directory (the key with mode 600), so it survives deploys.
 */
export function serviceCertificate(stateDir: string, id: string, names: string[]): Certificate {
	const dir = path.join(stateDir, 'tls', id);
	try {
		const cert = readFileSync(path.join(dir, 'server.crt'), 'utf8');
		const key = readFileSync(path.join(dir, 'server.key'), 'utf8');
		createPrivateKey(key);
		return { cert, key };
	} catch {
		const created = selfSignedCertificate(names);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(path.join(dir, 'server.key'), created.key, { mode: 0o600 });
		writeFileSync(path.join(dir, 'server.crt'), created.cert, { mode: 0o644 });
		return created;
	}
}
