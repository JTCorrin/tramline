import { TrafficQuery } from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { notFound, validationFailed } from '../api/errors';
import { node } from '../db/schema';
import { DEFAULT_TRAFFIC } from '../settings';
import { sshFailures, traffic } from '../traffic/store';
import { requireInstance, requireManager } from './access';
import { requireInstallAdmin } from './admins';
import type { Ctx } from './context';

/**
 * Who reached a service, and how it answered. Access logs carry visitors'
 * addresses, so only the organization's owners and admins see them.
 */
export function serviceTraffic(
	ctx: Ctx,
	serviceId: string,
	params: Record<string, string>,
	options: { networks: boolean },
	now = Date.now()
) {
	const parsed = TrafficQuery.safeParse(params);
	if (!parsed.success) throw validationFailed(parsed.error);
	requireInstance(ctx, serviceId, parsed.data.environmentId);
	requireManager(ctx, 'see who reached a service');
	const settings = ctx.settings.traffic ?? DEFAULT_TRAFFIC;
	return traffic(ctx.db, serviceId, parsed.data, { ...settings, ...options }, now);
}

/** Failed SSH logins on a node over the last day. Nodes belong to the install, and so do these. */
export function nodeSshFailures(ctx: Ctx, nodeId: string, now = Date.now()) {
	requireInstallAdmin(ctx, "see a node's failed SSH logins");
	if (!ctx.db.select({ id: node.id }).from(node).where(eq(node.id, nodeId)).get()) {
		throw notFound('Node');
	}
	return sshFailures(ctx.db, nodeId, now);
}
