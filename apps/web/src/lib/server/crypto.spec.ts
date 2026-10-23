import { describe, expect, it } from 'vitest';
import { createSecrets } from './crypto';

describe('createSecrets', () => {
	it('round-trips and produces a different ciphertext each time', () => {
		const secrets = createSecrets('a'.repeat(32));
		const a = secrets.encrypt('hunter2');
		expect(a).toMatch(/^v1\./);
		expect(a).not.toBe(secrets.encrypt('hunter2'));
		expect(secrets.decrypt(a)).toBe('hunter2');
	});

	it('fails to decrypt with a different key', () => {
		const value = createSecrets('a'.repeat(32)).encrypt('hunter2');
		expect(() => createSecrets('b'.repeat(32)).decrypt(value)).toThrow();
	});
});
