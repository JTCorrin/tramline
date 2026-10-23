import type { Resource } from '@tramline/client';
import { describe, expect, it, vi } from 'vitest';
import { Collection } from './collection.svelte';

type Item = { id: string; name: string };

function fakeResource(
	overrides: Partial<Resource<Item, { name: string }, { name: string }, never>> = {}
) {
	return {
		getAll: vi.fn(async () => [{ id: '1', name: 'fresh' }]),
		get: vi.fn(),
		create: vi.fn(async (input: { name: string }) => ({ id: '2', ...input })),
		update: vi.fn(async (id: string, patch: { name: string }) => ({ id, name: `${patch.name}!` })),
		remove: vi.fn(async () => {}),
		...overrides
	} as Resource<Item, { name: string }, { name: string }, never>;
}

describe('Collection', () => {
	it('refreshes, creates, updates and removes', async () => {
		const items = new Collection(fakeResource(), [{ id: '1', name: 'a' }]);

		await items.refresh();
		expect(items.items).toEqual([{ id: '1', name: 'fresh' }]);
		expect(items.loading).toBe(false);

		await items.create({ name: 'b' });
		expect(items.get('2')).toEqual({ id: '2', name: 'b' });

		await items.update('1', { name: 'c' });
		expect(items.get('1')?.name).toBe('c!'); // server response wins over the optimistic value

		await items.remove('2');
		expect(items.items.map((i) => i.id)).toEqual(['1']);
	});

	it('applies updates optimistically and rolls back on failure', async () => {
		let reject!: (error: Error) => void;
		const update = vi.fn(() => new Promise<Item>((_, r) => (reject = r)));
		const items = new Collection(fakeResource({ update }), [{ id: '1', name: 'a' }]);

		const pending = items.update('1', { name: 'b' });
		expect(items.get('1')?.name).toBe('b');
		reject(new Error('nope'));
		await expect(pending).rejects.toThrow('nope');
		expect(items.get('1')?.name).toBe('a');
	});

	it('restores removed items when the server refuses', async () => {
		const remove = vi.fn(async () => {
			throw new Error('forbidden');
		});
		const items = new Collection(fakeResource({ remove }), [{ id: '1', name: 'a' }]);
		await expect(items.remove('1')).rejects.toThrow('forbidden');
		expect(items.items).toHaveLength(1);
	});
});
