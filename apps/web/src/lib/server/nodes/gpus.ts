import type { GpuRequest } from '@tramline/contracts';
import type { deployment, node, OfferGpu } from '../db/schema';
import { replicaNode } from './placement';

/**
 * GPUs are handed out whole: each replica of a service that asks for them
 * gets its own, by index on its node, recorded on the deployment
 * (`replicaGpus`) so the assignment stays put while it runs.
 */

type NodeRow = typeof node.$inferSelect;
type DeploymentRow = typeof deployment.$inferSelect;

/** What a service's replicas ask for; services saved before GPUs existed ask for none. */
export const gpuRequest = (config: { deploy: { gpus?: GpuRequest | null } }) =>
	config.deploy.gpus ?? null;

export interface NodeGpu {
	index: string;
	model: string;
	/** Per GPU; from the driver when it says, else from the size the machine was created as. */
	vramGb: number | null;
}

/** The GPUs a node can hand to containers: none unless Docker has the NVIDIA runtime. */
export function nodeGpus(n: Pick<NodeRow, 'info' | 'offerGpu'>): NodeGpu[] {
	if (!n.info?.gpuRuntime) return [];
	return (n.info.gpus ?? []).map((gpu, i) => ({
		index: String(i),
		model: gpu.model,
		vramGb: gpu.vramMb ? Math.floor(gpu.vramMb / 1024) : (n.offerGpu?.vramGb ?? null)
	}));
}

/** A GPU, or a size's GPUs, meets a request's model and memory. */
export function gpuMatches(gpu: { model: string; vramGb: number | null }, req: GpuRequest) {
	const model = !req.model || gpu.model.toLowerCase().includes(req.model.toLowerCase());
	// unknown memory can't be promised
	const vram = !req.minVramGb || (gpu.vramGb !== null && gpu.vramGb >= req.minVramGb);
	return model && vram;
}

/** A machine size has enough of the right GPUs for one replica (node pools grow by this). */
export const offerFits = (gpu: OfferGpu | null, req: GpuRequest | null) =>
	!req || (!!gpu && gpu.count >= req.count && gpuMatches(gpu, req));

/** Indices of a node's GPUs that these deployments' replicas hold. */
export function heldOn(
	deployments: Pick<DeploymentRow, 'nodeId' | 'replicaNodes' | 'replicaGpus'>[],
	nodeId: string
) {
	const held = new Set<string>();
	for (const dep of deployments) {
		dep.replicaGpus?.forEach((gpus, replica) => {
			if (replicaNode(dep, replica) === nodeId) for (const g of gpus) held.add(g);
		});
	}
	return held;
}

/** The matching GPUs on a node that nothing holds, in index order. */
export const freeGpus = (n: NodeRow, req: GpuRequest, held: Set<string>) =>
	nodeGpus(n)
		.filter((g) => !held.has(g.index) && gpuMatches(g, req))
		.map((g) => g.index);

/** "1 GPU", "2 A100 GPUs with 80 GB each". */
export function describeGpus(req: GpuRequest) {
	const plural = req.count === 1 ? 'GPU' : 'GPUs';
	const each = req.minVramGb ? ` with ${req.minVramGb} GB${req.count > 1 ? ' each' : ''}` : '';
	return `${req.count} ${req.model ? `${req.model} ` : ''}${plural}${each}`;
}
