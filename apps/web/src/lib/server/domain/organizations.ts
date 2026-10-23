import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { member, organization } from '../db/schema';

/** Organizations the user belongs to, oldest membership first. */
export function listForUser(db: Db, userId: string) {
	return db
		.select({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			role: member.role
		})
		.from(member)
		.innerJoin(organization, eq(member.organizationId, organization.id))
		.where(eq(member.userId, userId))
		.orderBy(asc(member.createdAt))
		.all();
}
