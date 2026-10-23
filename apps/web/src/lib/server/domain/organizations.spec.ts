import { describe, expect, it } from 'vitest';
import { member, organization } from '../db/schema';
import { createTestDb, seedCtx } from '../testing';
import { listForUser } from './organizations';

describe('organizations.listForUser', () => {
	it('lists memberships oldest first with roles', () => {
		const db = createTestDb();
		const { userId, organizationId } = seedCtx(db);
		db.insert(organization)
			.values({ id: 'org_b', name: 'Beta', slug: 'beta', createdAt: new Date() })
			.run();
		db.insert(member)
			.values({
				id: 'm_b',
				organizationId: 'org_b',
				userId,
				role: 'member',
				createdAt: new Date(Date.now() + 1000)
			})
			.run();
		seedCtx(db); // someone else's organization

		expect(listForUser(db, userId)).toEqual([
			expect.objectContaining({ id: organizationId, role: 'owner' }),
			{ id: 'org_b', name: 'Beta', slug: 'beta', role: 'member' }
		]);
	});
});
