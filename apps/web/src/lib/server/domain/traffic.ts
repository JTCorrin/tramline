import { TrafficQuery } from '@tramline/contracts';
import { validationFailed } from '../api/errors';
import { DEFAULT_TRAFFIC } from '../settings';
import { traffic } from '../traffic/store';
import { requireInstance, requireManager } from './access';
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
