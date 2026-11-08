/** Machine sizes, as the add-node and node-pool forms show them. */

/**
 * Below this a new machine struggles to install Docker and pull the agent at
 * first boot, and may never join.
 */
export const MIN_MEMORY_MB = 1024;

/** "512 MB", "1 GB", "3.5 GB". */
export function formatMemory(mb: number) {
	if (mb < 1024) return `${mb} MB`;
	const gb = mb / 1024;
	return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

/** The first size big enough to join reliably, or the first one there is. */
export function defaultOffer<T extends { id: string; memoryMb: number }>(offers: T[]) {
	return (offers.find((o) => o.memoryMb >= MIN_MEMORY_MB) ?? offers[0])?.id ?? '';
}

/** Why a size is too small, or null when it's fine. */
export function tooSmall(offer: { memoryMb: number } | undefined) {
	if (!offer || offer.memoryMb >= MIN_MEMORY_MB) return null;
	return `${formatMemory(offer.memoryMb)} is too little to install Docker and the agent at first boot, so the machine may never join. Pick one with at least 1 GB.`;
}
