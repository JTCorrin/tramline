import { createSecrets } from './crypto';
import { createDb, type Db } from './db/client';
import { member, organization, user } from './db/schema';
import type { Ctx } from './domain';

/** A migrated in-memory database. */
export const createTestDb = () => createDb(':memory:');

let seq = 0;

export const testSecrets = createSecrets('test-secret-key-that-is-long-enough-123');

/** Seeds a user who is a member of a fresh organization and returns a domain context for them. */
export function seedCtx(db: Db = createTestDb()): Ctx {
	const n = ++seq;
	const now = new Date();
	const userId = `user_${n}`;
	const organizationId = `org_${n}`;

	db.insert(user)
		.values({ id: userId, name: `User ${n}`, email: `user${n}@example.com` })
		.run();
	db.insert(organization)
		.values({ id: organizationId, name: `Org ${n}`, slug: `org-${n}`, createdAt: now })
		.run();
	db.insert(member)
		.values({ id: `mem_${n}`, organizationId, userId, role: 'owner', createdAt: now })
		.run();

	return { db, secrets: testSecrets, userId, organizationId };
}
