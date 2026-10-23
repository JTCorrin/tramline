import type { ActualContainer, DesiredState } from '@tramline/contracts';
import type { Converger } from './converge';
import type { HealthChecker } from './health';
import { LABELS, type ManagedContainer } from './runtime';

const STATES: Record<ManagedContainer['status'], ActualContainer['state']> = {
	created: 'starting',
	running: 'running',
	paused: 'running',
	restarting: 'restarting',
	exited: 'exited',
	dead: 'exited',
	removing: 'exited'
};

/** What the agent reports: every desired container, whether or not it exists yet. */
export function observe(
	desired: DesiredState,
	containers: ManagedContainer[],
	converger: Pick<Converger, 'pulling' | 'errors'>,
	health: Pick<HealthChecker, 'results'>
): ActualContainer[] {
	const byName = new Map(containers.map((c) => [c.name, c]));
	return desired.containers.map((spec) => {
		const found = byName.get(spec.name);
		const error = converger.errors.get(spec.name) ?? null;
		// a container from an older spec is about to be replaced; report it as not started yet
		const current =
			found && found.labels[LABELS.deployment] === spec.deploymentId ? found : undefined;
		return {
			name: spec.name,
			deploymentId: spec.deploymentId,
			replica: spec.replica,
			state: error
				? 'error'
				: current
					? STATES[current.status]
					: converger.pulling.has(spec.name)
						? 'pulling'
						: 'starting',
			healthy: spec.healthcheckPath ? (health.results.get(spec.name) ?? null) : null,
			exitCode: current?.exitCode ?? null,
			restartCount: current?.restartCount ?? 0,
			error,
			startedAt: current?.status === 'running' ? current.startedAt : null,
			imageDigest: current?.imageDigest ?? null
		};
	});
}
