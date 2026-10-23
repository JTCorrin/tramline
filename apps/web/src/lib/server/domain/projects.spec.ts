import { describe, expect, it } from 'vitest';
import { seedCtx } from '../testing';
import * as projects from './projects';

describe('projects domain', () => {
	it('creates, lists, gets, updates and removes projects', () => {
		const ctx = seedCtx();

		const created = projects.create(ctx, { name: 'Storefront', description: 'Shop backend' });
		expect(created).toMatchObject({
			name: 'Storefront',
			description: 'Shop backend',
			organizationId: ctx.organizationId
		});
		expect(created.id).toMatch(/^prj_[0-9a-z]{26}$/);

		expect(projects.list(ctx).map((p) => p.id)).toEqual([created.id]);
		expect(projects.get(ctx, created.id).name).toBe('Storefront');

		const renamed = projects.update(ctx, created.id, { name: 'Shop', description: '' });
		expect(renamed).toMatchObject({ name: 'Shop', description: null });

		projects.remove(ctx, created.id);
		expect(projects.list(ctx)).toEqual([]);
	});

	it('stores an empty description as null', () => {
		const ctx = seedCtx();
		expect(projects.create(ctx, { name: 'API', description: '' }).description).toBeNull();
	});

	it('scopes every operation to the caller organization', () => {
		const alice = seedCtx();
		const bob = seedCtx(alice.db);
		const secret = projects.create(alice, { name: 'Alice only' });

		expect(projects.list(bob)).toEqual([]);
		expect(() => projects.get(bob, secret.id)).toThrow('Project not found');
		expect(() => projects.update(bob, secret.id, { name: 'Hijacked' })).toThrow(
			'Project not found'
		);
		expect(() => projects.remove(bob, secret.id)).toThrow('Project not found');
		expect(projects.get(alice, secret.id).name).toBe('Alice only');
	});

	it('throws not_found for unknown ids', () => {
		const ctx = seedCtx();
		expect(() => projects.get(ctx, 'prj_missing')).toThrowError(
			expect.objectContaining({ code: 'not_found', status: 404 })
		);
	});
});
