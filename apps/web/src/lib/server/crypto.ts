import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export interface Secrets {
	encrypt(plaintext: string): string;
	decrypt(ciphertext: string): string;
}

const VERSION = 'v1.';

/**
 * AES-256-GCM encryption for secrets at rest (variable values, later cloud
 * credentials). The key is derived from TRAMLINE_SECRET_KEY, so rotating that
 * key makes existing secrets unreadable.
 */
export function createSecrets(secret: string): Secrets {
	const key = Buffer.from(hkdfSync('sha256', secret, 'tramline', 'secrets-v1', 32));

	return {
		encrypt(plaintext) {
			const iv = randomBytes(12);
			const cipher = createCipheriv('aes-256-gcm', key, iv);
			const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
			return VERSION + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
		},
		decrypt(value) {
			if (!value.startsWith(VERSION)) throw new Error('Unknown secret format');
			const raw = Buffer.from(value.slice(VERSION.length), 'base64url');
			const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
			decipher.setAuthTag(raw.subarray(12, 28));
			return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
		}
	};
}

/** A random, URL-safe password. */
export const randomSecret = (bytes = 24) => randomBytes(bytes).toString('base64url');
