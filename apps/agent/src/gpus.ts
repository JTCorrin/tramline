import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Where the NVIDIA kernel driver describes each GPU; visible inside the agent's container too. */
export const NVIDIA_GPUS = '/proc/driver/nvidia/gpus';

/**
 * The NVIDIA GPUs this machine has, read from the kernel driver, so it works
 * without nvidia-smi or the container toolkit. The driver doesn't say how
 * much memory each has, so VRAM is left unknown here.
 */
export async function detectGpus(dir = NVIDIA_GPUS) {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		// no driver, no GPUs
		return [];
	}
	const gpus: { model: string; vramMb: number | null }[] = [];
	for (const entry of entries.sort()) {
		const info = await readFile(path.join(dir, entry, 'information'), 'utf8').catch(() => '');
		const model = info.match(/^Model:\s*(.+)$/m)?.[1]?.trim();
		if (model) gpus.push({ model, vramMb: null });
	}
	return gpus.slice(0, 64);
}
