import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar-stream';
import { RAILPACK } from './pins';

/**
 * Returns the Railpack CLI for a Docker host architecture, downloading it from
 * the official release the first time and refusing anything whose checksum
 * doesn't match the pin.
 */
export async function railpackBinary(
	stateDir: string,
	arch: string,
	fetcher: typeof fetch = globalThis.fetch
): Promise<Buffer> {
	const target = RAILPACK.target[arch];
	const expected = RAILPACK.sha256[arch];
	if (!target || !expected) throw new Error(`Railpack has no build for ${arch}`);

	const file = path.join(stateDir, 'railpack', RAILPACK.version, arch, 'railpack');
	if (existsSync(file)) return readFileSync(file);

	const name = `railpack-${RAILPACK.version}-${target}.tar.gz`;
	const url = `https://github.com/railwayapp/railpack/releases/download/${RAILPACK.version}/${name}`;
	const response = await fetcher(url);
	if (!response.ok) throw new Error(`Downloading ${name} failed: HTTP ${response.status}`);
	const tarball = Buffer.from(await response.arrayBuffer());

	const actual = createHash('sha256').update(tarball).digest('hex');
	if (actual !== expected) {
		throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
	}

	const binary = await extractFile(tarball, 'railpack');
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, binary, { mode: 0o755 });
	return binary;
}

/** Reads one file (by basename) out of a .tar.gz. */
export function extractFile(tarball: Buffer, name: string) {
	return new Promise<Buffer>((resolve, reject) => {
		const tar = extract();
		let found: Buffer | null = null;
		tar.on('entry', (header, stream, next) => {
			const chunks: Buffer[] = [];
			stream.on('data', (chunk: unknown) => chunks.push(chunk as Buffer));
			stream.on('end', () => {
				if (path.basename(header.name) === name && header.type === 'file')
					found = Buffer.concat(chunks);
				next();
			});
		});
		tar.on('finish', () =>
			found ? resolve(found) : reject(new Error(`${name} not found in archive`))
		);
		tar.on('error', reject);
		Readable.from(tarball).pipe(createGunzip()).on('error', reject).pipe(tar);
	});
}
