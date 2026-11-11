import type {
	AdapterAccount,
	AdapterInfo,
	AdapterOffer,
	AdapterRegion,
	CreateAdapterAccount,
	LeftoverMachine,
	Placement,
	PlacementRequest,
	ProviderNodeCreated,
	ProvisioningNode,
	ProvisionNode,
	UpdateAdapterAccount
} from '@tramline/contracts';
import type { Http } from '../http';

/** Compute adapters, and the install's accounts with them (install admins only). */
export const adapters = (http: Http) => ({
	getAll: () => http.get<AdapterInfo[]>('/adapters'),
	accounts: () => http.get<AdapterAccount[]>('/adapter-accounts'),
	connect: (input: CreateAdapterAccount) => http.post<AdapterAccount>('/adapter-accounts', input),
	updateAccount: (id: string, input: UpdateAdapterAccount) =>
		http.patch<AdapterAccount>(`/adapter-accounts/${id}`, input),
	removeAccount: (id: string) => http.delete<void>(`/adapter-accounts/${id}`),
	/** "Test connection". */
	test: (id: string) => http.post<{ ok: true }>(`/adapter-accounts/${id}/test`),
	regions: (id: string) => http.get<AdapterRegion[]>(`/adapter-accounts/${id}/regions`),
	offers: (id: string, region: string) =>
		http.get<AdapterOffer[]>(
			`/adapter-accounts/${id}/regions/${encodeURIComponent(region)}/offers`
		),
	/** Creates a machine with an account; it appears as a node once it enrolls. */
	provision: (input: ProvisionNode) => http.post<ProviderNodeCreated>('/nodes/provision', input),
	provisioning: () => http.get<ProvisioningNode[]>('/nodes/provisioning'),
	/** Machines with Tramline's tag that no node accounts for. */
	leftovers: (id: string) => http.get<LeftoverMachine[]>(`/adapter-accounts/${id}/leftovers`),
	destroyLeftover: (id: string, machine: string) =>
		http.delete<void>(`/adapter-accounts/${id}/leftovers/${encodeURIComponent(machine)}`),
	/** Where a workload could run, and what each option costs a month. */
	placement: (input: PlacementRequest) => http.post<Placement>('/placement', input),
	/** Destroys a machine that hasn't enrolled. */
	cancel: (id: string) => http.delete<void>(`/nodes/provisioning/${id}`)
});
