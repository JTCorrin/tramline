import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Tramline's encrypted backup format, shared with the agent
 * (apps/agent/src/backups.ts): magic, 12-byte IV, AES-256-GCM ciphertext,
 * 16-byte tag.
 */
export const MAGIC = Buffer.from('TLB1');

/** Streams plaintext into the encrypted format. */
export function encrypt(key: Buffer) {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	let started = false;
	const head = () => {
		if (started) return [];
		started = true;
		return [MAGIC, iv];
	};
	return new Transform({
		transform(chunk: Buffer, _encoding, done) {
			done(null, Buffer.concat([...head(), cipher.update(chunk)]));
		},
		flush(done) {
			done(null, Buffer.concat([...head(), cipher.final(), cipher.getAuthTag()]));
		}
	});
}

/** Decrypts a file, failing (and leaving no output) if it was altered or the key is wrong. */
export async function decryptFile(input: string, output: string, key: Buffer) {
	const size = statSync(input).size;
	if (size < MAGIC.length + 12 + 16) throw new Error('The backup is truncated');
	const handle = await open(input, 'r');
	try {
		const head = Buffer.alloc(MAGIC.length + 12);
		await handle.read(head, 0, head.length, 0);
		if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Tramline backup');
		const tag = Buffer.alloc(16);
		await handle.read(tag, 0, 16, size - 16);
		const decipher = createDecipheriv('aes-256-gcm', key, head.subarray(MAGIC.length));
		decipher.setAuthTag(tag);
		await pipeline(
			size > head.length + 16
				? createReadStream(input, { start: head.length, end: size - 17 })
				: Readable.from([]),
			decipher,
			createWriteStream(output, { mode: 0o600 })
		);
	} catch (error) {
		rmSync(output, { force: true });
		throw error instanceof Error && error.message.includes('authenticate')
			? new Error('The backup failed its integrity check (wrong key or altered file)')
			: error;
	} finally {
		await handle.close();
	}
}
