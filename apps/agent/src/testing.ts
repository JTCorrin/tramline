import type { DesiredContainer, DesiredState } from '@tramline/contracts';
import type { ContainerRuntime, ManagedContainer, OnLogLine, RunSpec } from './runtime';

/** In-memory ContainerRuntime for tests. */
export class FakeRuntime implements ContainerRuntime {
	containers = new Map<string, ManagedContainer & { spec: RunSpec }>();
	networks = new Set<string>();
	images = new Set<string>();
	calls: string[] = [];
	failPull = new Map<string, string>();
	execExit = 0;
	down = false;
	followers = new Map<string, { since: number; onLine: OnLogLine; onEnd: () => void }>();

	#guard(call: string) {
		if (this.down) throw new Error('connect ENOENT /var/run/docker.sock');
		this.calls.push(call);
	}

	async version() {
		this.#guard('version');
		return '27.0.0';
	}
	async ensureNetwork(name: string) {
		this.#guard(`network ${name}`);
		this.networks.add(name);
	}
	async list() {
		this.#guard('list');
		return [...this.containers.values()].map(({ spec: _, ...c }) => ({ ...c }));
	}
	async hasImage(image: string) {
		return this.images.has(image);
	}
	async pull(image: string) {
		this.#guard(`pull ${image}`);
		const error = this.failPull.get(image);
		if (error) throw new Error(error);
		this.images.add(image);
	}
	async run(spec: RunSpec) {
		this.#guard(`run ${spec.name}`);
		this.containers.set(spec.name, {
			spec,
			name: spec.name,
			labels: spec.labels,
			networks: [spec.network],
			status: 'running',
			exitCode: null,
			restartCount: 0,
			startedAt: new Date().toISOString()
		});
	}
	async remove(name: string) {
		this.#guard(`remove ${name}`);
		this.containers.delete(name);
	}
	async connect(container: string, network: string) {
		this.#guard(`connect ${container} ${network}`);
		this.containers.get(container)?.networks.push(network);
	}
	async exec(container: string, cmd: string[]) {
		this.#guard(`exec ${container} ${cmd.at(-1)}`);
		return { exitCode: this.execExit, output: '' };
	}
	logs(name: string, since: number, onLine: OnLogLine, onEnd: () => void) {
		this.followers.set(name, { since, onLine, onEnd });
		return () => this.followers.delete(name);
	}
}

export function desiredContainer(overrides: Partial<DesiredContainer> = {}): DesiredContainer {
	return {
		name: 'tl-dep_1-0',
		deploymentId: 'dep_1',
		serviceId: 'svc_1',
		environmentId: 'env_1',
		replica: 0,
		image: 'traefik/whoami',
		command: null,
		env: { PORT: '80' },
		network: 'tl-env_1',
		aliases: ['whoami.production.tramline.internal', 'dep_1.tramline.internal'],
		restartPolicy: 'on_failure',
		port: 80,
		healthcheckPath: null,
		memoryMb: null,
		readOnlyRootFilesystem: false,
		...overrides
	};
}

export function desiredState(
	containers: DesiredContainer[] = [desiredContainer()],
	routes: DesiredState['ingress']['routes'] = []
): DesiredState {
	return {
		revision: `rev-${containers.map((c) => c.name).join(',')}-${routes.length}`,
		networks: [...new Set(containers.map((c) => c.network))],
		containers,
		ingress: { httpPort: 8080, tls: false, routes }
	};
}
