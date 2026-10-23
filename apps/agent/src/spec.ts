import type { DesiredContainer } from '@tramline/contracts';
import { createHash } from 'node:crypto';
import { LABELS, type RunSpec } from './runtime';

/** Docker allows this many restarts for `on_failure` before giving up. */
export const ON_FAILURE_RETRIES = 10;

/**
 * Capabilities workloads keep. Docker's defaults minus NET_RAW (raw sockets,
 * spoofing), MKNOD, AUDIT_WRITE, SETFCAP, SETPCAP and SYS_CHROOT. What is left
 * covers official images that drop root at startup (postgres, redis, mysql).
 */
export const WORKLOAD_CAPABILITIES = [
	'CHOWN',
	'DAC_OVERRIDE',
	'FOWNER',
	'FSETID',
	'KILL',
	'NET_BIND_SERVICE',
	'SETGID',
	'SETUID'
];

/** Stops fork bombs from taking down the node. */
export const WORKLOAD_PIDS_LIMIT = 1024;

export const hash = (value: unknown) =>
	createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** Translates a desired container into what Docker should run. */
export function toRunSpec(container: DesiredContainer, nodeId: string): RunSpec {
	return {
		name: container.name,
		image: container.image,
		cmd: container.command ? ['/bin/sh', '-c', container.command] : undefined,
		env: container.env,
		network: container.network,
		// workloads never get host mounts, so the Docker socket can't leak into them
		security: {
			capabilities: WORKLOAD_CAPABILITIES,
			pidsLimit: WORKLOAD_PIDS_LIMIT,
			memoryMb: container.memoryMb,
			readOnlyRootFilesystem: container.readOnlyRootFilesystem
		},
		aliases: container.aliases,
		restart:
			container.restartPolicy === 'always'
				? { name: 'always', maxRetries: 0 }
				: container.restartPolicy === 'never'
					? { name: 'no', maxRetries: 0 }
					: { name: 'on-failure', maxRetries: ON_FAILURE_RETRIES },
		labels: {
			[LABELS.managed]: 'true',
			[LABELS.node]: nodeId,
			[LABELS.role]: 'workload',
			// a container is replaced, never mutated, when anything about it changes
			[LABELS.spec]: hash(container),
			[LABELS.deployment]: container.deploymentId,
			[LABELS.replica]: String(container.replica)
		}
	};
}
