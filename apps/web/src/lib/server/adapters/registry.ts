import { credentialFields, fakeAdapter, type ComputeAdapter } from '@tramline/adapter-sdk';
import { manual } from '@tramline/adapter-manual';
import type { AdapterInfo } from '@tramline/contracts';

/**
 * The compute adapters this install offers. Each is a package implementing
 * the adapter contract; nothing outside it knows about any one provider.
 */
const adapters = new Map<string, ComputeAdapter>([[manual.meta.id, manual as ComputeAdapter]]);

/** Adds an adapter: the fake one for tests (TRAMLINE_FAKE_ADAPTER), say. */
export function registerAdapter(adapter: ComputeAdapter) {
	adapters.set(adapter.meta.id, adapter);
}

/** The in-memory fake adapter, offered when TRAMLINE_FAKE_ADAPTER=1 (tests only). */
export function registerFakeAdapter() {
	if (!adapters.has('fake')) registerAdapter(fakeAdapter().adapter as ComputeAdapter);
}

export function getAdapter(id: string) {
	return adapters.get(id);
}

export function listAdapters(): AdapterInfo[] {
	return [...adapters.values()].map((adapter) => ({
		...adapter.meta,
		capabilities: adapter.capabilities,
		fields: credentialFields(adapter.credentials)
	}));
}
