import { z } from 'zod';
import { AdapterError, defineAdapter, type NodeSpec, type ProviderNode } from './contract';

/** The token the fake adapter accepts. */
export const FAKE_TOKEN = 'fake-token';

const credentials = z.object({
	apiToken: z.string().min(1).meta({ title: 'API token', secret: true, placeholder: FAKE_TOKEN }),
	project: z.string().min(1).default('default').meta({ description: 'Where its machines go' })
});

/**
 * An in-memory adapter for tests: it creates machines that exist only in
 * its state. `onCreate` can play the part of the machine booting and
 * enrolling.
 */
export function fakeAdapter(
	options: { onCreate?: (spec: NodeSpec, node: ProviderNode) => void } = {}
) {
	const machines = new Map<string, ProviderNode & { spec: NodeSpec }>();
	let seq = 0;
	const check = async (creds: z.infer<typeof credentials>) => {
		if (creds.apiToken !== FAKE_TOKEN) throw new AdapterError('The API token was rejected');
	};
	const strip = ({ spec: _spec, ...node }: ProviderNode & { spec: NodeSpec }): ProviderNode => node;

	const adapter = defineAdapter({
		meta: {
			id: 'fake',
			name: 'Fake cloud',
			icon: 'flask-conical',
			description: 'Machines that exist only in memory, for tests'
		},
		credentials,
		capabilities: { spot: true, arch: ['amd64'], autoProvision: true, gpus: true, inventory: true },
		validate: check,
		async listRegions(creds) {
			await check(creds);
			return [{ id: 'fake-1', name: 'Fake Region 1' }];
		},
		async listOffers(creds, region) {
			await check(creds);
			if (region !== 'fake-1') return [];
			return [
				{
					id: 'small',
					region,
					name: 'Small',
					vcpus: 2,
					memoryMb: 4096,
					diskGb: 40,
					arch: 'amd64',
					gpu: null,
					hourly: 0.01,
					spotHourly: 0.004,
					egressPerGb: 0.01
				},
				{
					id: 'gpu',
					region,
					name: 'GPU',
					vcpus: 8,
					memoryMb: 65_536,
					diskGb: 200,
					arch: 'amd64',
					gpu: { model: 'NVIDIA L4', count: 1, vramGb: 24 },
					hourly: 0.8,
					spotHourly: null,
					egressPerGb: 0.01
				}
			];
		},
		async createNode(creds, spec) {
			await check(creds);
			if (!(await adapter.listOffers(creds, spec.region)).some((o) => o.id === spec.offer)) {
				throw new AdapterError(`No size ${spec.offer} in ${spec.region}`);
			}
			const machine = {
				id: `fake-${++seq}`,
				name: spec.name,
				region: spec.region,
				status: 'provisioning' as const,
				address: `198.51.100.${seq}`,
				instructions: null,
				spec
			};
			machines.set(machine.id, machine);
			options.onCreate?.(spec, strip(machine));
			return strip(machine);
		},
		async getNode(creds, id) {
			await check(creds);
			const machine = machines.get(id);
			return machine ? strip(machine) : null;
		},
		async listNodes(creds) {
			await check(creds);
			return [...machines.values()].map(strip);
		},
		async destroyNode(creds, id) {
			await check(creds);
			machines.delete(id);
		}
	});
	return { adapter, machines };
}
