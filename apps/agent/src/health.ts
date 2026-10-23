import type { DesiredState } from '@tramline/contracts';
import { INGRESS_NAME } from './caddy';
import type { ContainerRuntime, ManagedContainer } from './runtime';

/**
 * HTTP healthchecks, run from inside the ingress container. It sits on every
 * environment network, so this works even where the agent can't reach
 * container IPs directly (e.g. Docker Desktop on macOS).
 */
export class HealthChecker {
	readonly results = new Map<string, boolean>();

	constructor(private runtime: ContainerRuntime) {}

	async check(desired: DesiredState, containers: ManagedContainer[]) {
		const running = new Set(containers.filter((c) => c.status === 'running').map((c) => c.name));
		for (const name of this.results.keys()) if (!running.has(name)) this.results.delete(name);

		const ingressUp = containers.some((c) => c.name === INGRESS_NAME && c.status === 'running');
		await Promise.all(
			desired.containers
				.filter((c) => c.healthcheckPath && c.port && running.has(c.name))
				.map(async (c) => {
					if (!ingressUp) return;
					const url = `http://${c.name}:${c.port}${c.healthcheckPath}`;
					try {
						// busybox wget exits 0 only for 2xx responses
						const { exitCode } = await this.runtime.exec(INGRESS_NAME, [
							'wget',
							'-q',
							'-O',
							'/dev/null',
							'-T',
							'3',
							url
						]);
						this.results.set(c.name, exitCode === 0);
					} catch {
						this.results.set(c.name, false);
					}
				})
		);
	}
}
