import type { Canvas } from '@tramline/contracts';
import { publicUrl } from '../settings';
import { requireEnvironment } from './access';
import type { Ctx } from './context';
import { latestStatuses } from './deployments';
import { referencedServices } from './resolve';
import { sourceLabel } from './staging';
import { hasStaged, loadEnvironmentState } from './state';

/** The project canvas for one environment: service nodes plus reference edges. */
export function get(ctx: Ctx, environmentId: string): Canvas {
	const env = requireEnvironment(ctx, environmentId);
	const state = loadEnvironmentState(ctx.db, ctx.secrets, env);
	const statuses = latestStatuses(ctx.db, environmentId);
	const idByName = new Map(state.services.map((svc) => [svc.service.name, svc.service.id]));

	const edges: Canvas['edges'] = [];
	for (const svc of state.services) {
		for (const name of referencedServices(svc.effectiveVariables, svc.service.name)) {
			const source = idByName.get(name);
			if (source)
				edges.push({ id: `${source}->${svc.service.id}`, source, target: svc.service.id });
		}
	}

	return {
		environmentId,
		services: state.services.map((svc) => ({
			id: svc.service.id,
			name: svc.service.name,
			kind: svc.service.kind,
			icon: svc.service.icon,
			position: { x: svc.service.positionX, y: svc.service.positionY },
			source: sourceLabel(svc.effective),
			status: statuses.get(svc.service.id) ?? 'undeployed',
			staged: hasStaged(svc.staged),
			publicDomain: svc.effective.networking.publicDomain,
			url: svc.domain ? publicUrl(ctx.settings, svc.domain) : null
		})),
		edges
	};
}
