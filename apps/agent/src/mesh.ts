import type { DesiredMesh } from '@tramline/contracts';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The mesh container runs the agent image in `mesh` mode (see mesh-daemon.ts). */
export const DEFAULT_MESH_IMAGE = 'ghcr.io/jtcorrin/tramline-agent:latest';
/** Where the agent puts the mesh config inside the mesh container. */
export const MESH_CONFIG_PATH = '/etc/tramline/mesh.json';

export const meshContainerName = (nodeId: string) => `tramline-mesh-${nodeId}`;
export const meshNetworkName = (nodeId: string) => `tl-mesh-${nodeId}`;

/** What the mesh daemon is told: the desired mesh, plus what only this node knows. */
export interface MeshConfig extends Omit<DesiredMesh, 'links'> {
	privateKey: string;
	/** The mesh container's address on the mesh network, where links and the ingress connect. */
	transitAddress: string;
}

const base64 = (b64url: string) => Buffer.from(b64url, 'base64url').toString('base64');

/**
 * This node's WireGuard key pair, created on first use and kept in the
 * agent's state directory (mode 600). Only the public key is ever sent.
 */
export function meshKeys(stateDir: string) {
	const file = path.join(stateDir, 'mesh.key');
	let privateKey: string;
	try {
		privateKey = readFileSync(file, 'utf8').trim();
	} catch {
		const jwk = generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
		privateKey = base64(jwk.d!);
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		// `wx`: never overwrite a key another process wrote meanwhile
		writeFileSync(file, privateKey + '\n', { mode: 0o600, flag: 'wx' });
	}
	return { privateKey, publicKey: publicKeyFor(privateKey) };
}

/** The WireGuard public key (base64) for a private key (base64). */
export function publicKeyFor(privateKey: string) {
	const key = createPrivateKey({
		key: Buffer.concat([
			// PKCS#8 prefix for a raw X25519 private key
			Buffer.from('302e020100300506032b656e04220420', 'hex'),
			Buffer.from(privateKey, 'base64')
		]),
		format: 'der',
		type: 'pkcs8'
	});
	const jwk = createPublicKey(key).export({ format: 'jwk' });
	return base64(jwk.x!);
}
