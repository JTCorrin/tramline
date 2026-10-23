import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar-stream';
import { RAILPACK, TRIVY } from './pins';

/** A CLI published as a .tar.gz on a GitHub release, pinned by checksum. */
export interface ReleaseTool {
	/** Binary name inside the archive, and the cache directory. */
	name: string;
	version: string;
	sha256: Record<string, string>;
	/** Download URL for a Docker host architecture, or null when there is no build for it. */
	url: (arch: string) => string | null;
}

export const RAILPACK_TOOL: ReleaseTool = {
	name: 'railpack',
	version: RAILPACK.version,
	sha256: RAILPACK.sha256,
	url: (arch) => {
		const target = RAILPACK.target[arch];
		return target
			? `https://github.com/railwayapp/railpack/releases/download/${RAILPACK.version}/railpack-${RAILPACK.version}-${target}.tar.gz`
			: null;
	}
};

export const TRIVY_TOOL: ReleaseTool = {
	name: 'trivy',
	version: TRIVY.version,
	sha256: TRIVY.sha256,
	url: (arch) => {
		const target = TRIVY.target[arch];
		return target
			? `https://github.com/aquasecurity/trivy/releases/download/v${TRIVY.version}/trivy_${TRIVY.version}_${target}.tar.gz`
			: null;
	}
};

/**
 * Returns a tool's binary for a Docker host architecture, downloading it from
 * the official release the first time and refusing anything whose checksum
 * doesn't match the pin.
 */
export async function releaseBinary(
	tool: ReleaseTool,
	stateDir: string,
	arch: string,
	fetcher: typeof fetch = globalThis.fetch
): Promise<Buffer> {
	const url = tool.url(arch);
	const expected = tool.sha256[arch];
	if (!url || !expected) throw new Error(`${tool.name} has no build for ${arch}`);

	const file = path.join(stateDir, tool.name, tool.version, arch, tool.name);
	if (existsSync(file)) return readFileSync(file);

	const name = path.posix.basename(url);
	const response = await fetcher(url);
	if (!response.ok) throw new Error(`Downloading ${name} failed: HTTP ${response.status}`);
	const tarball = Buffer.from(await response.arrayBuffer());

	const actual = createHash('sha256').update(tarball).digest('hex');
	if (actual !== expected) {
		throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
	}

	const binary = await extractFile(tarball, tool.name);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, binary, { mode: 0o755 });
	return binary;
}

export const railpackBinary = (stateDir: string, arch: string, fetcher?: typeof fetch) =>
	releaseBinary(RAILPACK_TOOL, stateDir, arch, fetcher);

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
