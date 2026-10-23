import type { DesiredContainer } from '@tramline/contracts';
import { createHash } from 'node:crypto';
import { LABELS, type RunSpec } from './runtime';

/** Docker allows this many restarts for `on_failure` before giving up. */
export const ON_FAILURE_RETRIES = 10;

export const hash = (value: unknown) =>
	createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** Translates a desired container into what Docker should run. */
export function toRunSpec(container: DesiredContainer): RunSpec {
	return {
		name: container.name,
		image: container.image,
		cmd: container.command ? ['/bin/sh', '-c', container.command] : undefined,
		env: container.env,
		network: container.network,
		aliases: container.aliases,
		restart:
			container.restartPolicy === 'always'
				? { name: 'always', maxRetries: 0 }
				: container.restartPolicy === 'never'
					? { name: 'no', maxRetries: 0 }
					: { name: 'on-failure', maxRetries: ON_FAILURE_RETRIES },
		labels: {
			[LABELS.managed]: 'true',
			[LABELS.role]: 'workload',
			// a container is replaced, never mutated, when anything about it changes
			[LABELS.spec]: hash(container),
			[LABELS.deployment]: container.deploymentId,
			[LABELS.replica]: String(container.replica)
		}
	};
}
