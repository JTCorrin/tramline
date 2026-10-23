import type { Resource } from '@tramline/client';

/**
 * Reactive, optimistic view over a REST collection. Components read
 * `items` and call `create`/`update`/`remove`; the server stays the source of truth.
 *
 * Create one per component tree (seeded from `load` data), never at module
 * level, so state is not shared between requests during SSR.
 */
export class Collection<T extends { id: string }, Create, Update> {
	items = $state<T[]>([]);
	loading = $state(false);

	readonly #resource: Resource<T, Create, Update, never>;

	constructor(resource: Resource<T, Create, Update, never>, initial: T[] = []) {
		this.#resource = resource;
		this.items = initial;
	}

	get(id: string) {
		return this.items.find((item) => item.id === id);
	}

	async refresh() {
		this.loading = true;
		try {
			this.items = await this.#resource.getAll();
		} finally {
			this.loading = false;
		}
	}

	async create(input: Create) {
		const created = await this.#resource.create(input);
		this.items = [...this.items, created];
		return created;
	}

	async update(id: string, patch: Update) {
		const previous = this.items;
		this.items = previous.map((item) => (item.id === id ? { ...item, ...patch } : item));
		try {
			const updated = await this.#resource.update(id, patch);
			this.items = this.items.map((item) => (item.id === id ? updated : item));
			return updated;
		} catch (error) {
			this.items = previous;
			throw error;
		}
	}

	async remove(id: string) {
		const previous = this.items;
		this.items = previous.filter((item) => item.id !== id);
		try {
			await this.#resource.remove(id);
		} catch (error) {
			this.items = previous;
			throw error;
		}
	}
}
