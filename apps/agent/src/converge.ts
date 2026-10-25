import type { DesiredState } from '@tramline/contracts';
import { INGRESS_CONFIG_PATH, INGRESS_IMAGE, caddyConfig, ingressName } from './caddy';
import { LABELS, type ContainerRuntime, type ManagedContainer } from './runtime';
import { hash, toRunSpec } from './spec';

export interface ConvergeOptions {
	/** Usually learned from the control plane at hello; required before the first run. */
	nodeId?: string;
	/**
	 * How long a container stays up after leaving the desired state, so traffic
	 * can move off it first (the ingress reloads its routes within about a second).
	 */
	drainMs?: number;
	now?: () => number;
	log?: (message: string) => void;
}

export const DEFAULT_DRAIN_MS = 10_000;

const quiet = () => {};

/** How long a workload gets to shut down after SIGTERM; more for ones with data on a volume. */
export const STOP_TIMEOUT_SECONDS = 10;
export const STATEFUL_STOP_TIMEOUT_SECONDS = 30;

/**
 * Makes the container runtime match a desired state. Idempotent and safe to
 * call repeatedly: it only removes containers Tramline manages, and replaces
 * any whose spec changed.
 */
export class Converger {
	/** Containers whose image is being pulled right now. */
	readonly pulling = new Set<string>();
	/** Containers that could not be started, with the reason (e.g. image not found). */
	readonly errors = new Map<string, string>();
	/** Containers not to start for now, e.g. while their volume is being restored. */
	readonly held = new Set<string>();

	/** The node whose containers this converger owns. */
	nodeId: string | null;

	#running: Promise<void> | null = null;
	#again = false;
	#latest: DesiredState | null = null;
	/** When each no-longer-desired container was first seen, for draining. */
	#leaving = new Map<string, number>();
	/** Route updates for the ingress, one at a time. */
	#routes: Promise<void> = Promise.resolve();
	/** The Caddy config the ingress last accepted. */
	#applied: string | null = null;
	/** Whether the ingress container has been seen or started, so routes can be pushed to it. */
	#ingressUp = false;

	constructor(
		private runtime: ContainerRuntime,
		private options: ConvergeOptions
	) {
		this.nodeId = options.nodeId ?? null;
	}

	get ingressName() {
		return ingressName(this.#node());
	}

	/** Whether a draining container is due for removal, so the agent should converge again. */
	get removalDue() {
		const now = this.#now();
		for (const since of this.#leaving.values()) if (now - since >= this.#drainMs) return true;
		return false;
	}

	/** Containers on the runtime that this node's agent manages. */
	owned(containers: ManagedContainer[]) {
		return containers.filter((c) => c.labels[LABELS.node] === this.nodeId);
	}

	#node() {
		if (!this.nodeId) throw new Error('nodeId is not known yet');
		return this.nodeId;
	}
	#now() {
		return (this.options.now ?? Date.now)();
	}
	get #drainMs() {
		return this.options.drainMs ?? DEFAULT_DRAIN_MS;
	}

	/** Converges to `desired`; overlapping calls coalesce into one follow-up run. */
	async run(desired: DesiredState): Promise<void> {
		this.#latest = desired;
		// Routes only ever point at live deployments, whose containers already run, so
		// they can go out at once. Waiting for the pass in progress would hold a new
		// route back for as long as another service's image takes to pull.
		void this.#publishRoutes(desired);
		if (this.#running) {
			this.#again = true;
			return this.#running;
		}
		this.#running = (async () => {
			try {
				do {
					this.#again = false;
					await this.#converge(this.#latest!);
				} while (this.#again);
			} finally {
				this.#running = null;
			}
		})();
		return this.#running;
	}

	async #converge(desired: DesiredState) {
		const log = this.options.log ?? quiet;
		const nodeId = this.#node();
		for (const network of desired.networks) await this.runtime.ensureNetwork(network);

		const wanted = new Map(desired.containers.map((c) => [c.name, toRunSpec(c, nodeId)]));
		const existing = this.owned(await this.runtime.list());
		const workloads = existing.filter((c) => c.labels[LABELS.role] === 'workload');
		const present = new Set<string>();
		const stale: ManagedContainer[] = [];

		for (const container of workloads) {
			const spec = wanted.get(container.name);
			if (!spec) stale.push(container);
			else if (spec.labels[LABELS.spec] === container.labels[LABELS.spec])
				present.add(container.name);
			else {
				// same name, different spec: replace in place
				log(`replacing ${container.name}`);
				await this.#stop(container);
			}
		}

		for (const name of this.errors.keys()) if (!wanted.has(name)) this.errors.delete(name);

		// 1. start what's missing
		for (const [name, spec] of wanted) {
			if (present.has(name) || this.errors.has(name) || this.held.has(name)) continue;
			try {
				if (!(await this.runtime.hasImage(spec.image))) {
					this.pulling.add(name);
					log(`pulling ${spec.image}`);
					await this.runtime.pull(spec.image);
				}
				for (const volume of spec.volumes ?? []) {
					await this.runtime.ensureVolume(volume.name, {
						[LABELS.managed]: 'true',
						[LABELS.node]: nodeId,
						[LABELS.role]: 'volume'
					});
				}
				log(`starting ${name}`);
				await this.runtime.run(spec);
			} catch (error) {
				this.errors.set(name, error instanceof Error ? error.message : String(error));
				log(`failed to start ${name}: ${this.errors.get(name)}`);
			} finally {
				this.pulling.delete(name);
			}
		}

		// 2. point routes at the new deployments (and drop routes to removed ones, even the last)
		if (desired.networks.length) await this.#ensureIngress(desired, existing);
		await this.#publishRoutes(desired);

		// 3. only then drain and remove what is no longer wanted
		const now = this.#now();
		const staleNames = new Set(stale.map((c) => c.name));
		for (const name of this.#leaving.keys()) if (!staleNames.has(name)) this.#leaving.delete(name);
		for (const container of stale) {
			const since = this.#leaving.get(container.name) ?? now;
			this.#leaving.set(container.name, since);
			if (now - since < this.#drainMs) continue;
			log(`removing ${container.name}`);
			await this.#stop(container);
			this.#leaving.delete(container.name);
		}

		// 4. volumes of deleted services, once no container uses them
		if (desired.deletedVolumes.length) {
			const deleted = new Set(desired.deletedVolumes);
			for (const volume of await this.runtime.listVolumes()) {
				if (!deleted.has(volume.name) || volume.labels[LABELS.node] !== nodeId) continue;
				if (await this.runtime.removeVolume(volume.name)) log(`removed volume ${volume.name}`);
			}
		}
	}

	/** Stops a workload gracefully (databases flush to disk), then removes it. */
	async #stop(container: ManagedContainer) {
		const stateful = container.labels[LABELS.stateful] === 'true';
		await this.runtime.stop(
			container.name,
			stateful ? STATEFUL_STOP_TIMEOUT_SECONDS : STOP_TIMEOUT_SECONDS
		);
		await this.runtime.remove(container.name);
	}

	/** Volumes this node manages, for the agent's report. */
	async volumes() {
		const nodeId = this.#node();
		return (await this.runtime.listVolumes())
			.filter((v) => v.labels[LABELS.node] === nodeId)
			.map((v) => v.name)
			.sort();
	}

	/**
	 * Hands Caddy its routes: the config is copied into the ingress container
	 * and loaded with `caddy reload`, which reports whether Caddy accepted it.
	 * Updates run one at a time, and a config is only recorded as applied once
	 * Caddy has taken it, so a failed reload is retried on the next pass.
	 *
	 * (Sharing a file from the host with `caddy run --watch` instead was flaky:
	 * Caddy could read a half-written file, and some file-sharing layers kept
	 * showing the container a stale copy, so new routes never went live.)
	 */
	#publishRoutes(desired: DesiredState) {
		const config = JSON.stringify(caddyConfig(desired.ingress), null, 2);
		this.#routes = this.#routes.then(async () => {
			if (!this.#ingressUp || config === this.#applied) return;
			const log = this.options.log ?? quiet;
			try {
				await this.runtime.putFile(
					this.ingressName,
					INGRESS_CONFIG_PATH,
					Buffer.from(config),
					0o644
				);
				const reload = await this.runtime.exec(this.ingressName, [
					'caddy',
					'reload',
					'--config',
					INGRESS_CONFIG_PATH
				]);
				if (reload.exitCode === 0) this.#applied = config;
				else log(`the ingress refused its routes: ${reload.output.trim().split('\n').at(-1)}`);
			} catch (error) {
				log(
					`updating the ingress failed: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		});
		return this.#routes;
	}

	async #ensureIngress(desired: DesiredState, existing: ManagedContainer[]) {
		const name = this.ingressName;
		const spec = {
			name,
			image: INGRESS_IMAGE,
			// routes are pushed by #publishRoutes; --resume brings the last ones back after a restart
			cmd: ['caddy', 'run', '--resume'],
			env: {},
			network: desired.networks[0]!,
			aliases: [],
			restart: { name: 'always' as const, maxRetries: 0 },
			ports: [
				{ container: 80, host: desired.ingress.httpPort },
				...(desired.ingress.tls ? [{ container: 443, host: 443 }] : [])
			],
			// Caddy only needs to bind ports 80/443 inside its container
			security: {
				capabilities: ['NET_BIND_SERVICE'],
				pidsLimit: 256,
				memoryMb: 256,
				readOnlyRootFilesystem: false
			},
			labels: {
				[LABELS.managed]: 'true',
				[LABELS.node]: this.#node(),
				[LABELS.role]: 'ingress',
				[LABELS.spec]: hash({
					port: desired.ingress.httpPort,
					tls: desired.ingress.tls,
					routes: 'pushed'
				})
			}
		};

		let ingress = existing.find((c) => c.name === name);
		if (ingress && ingress.labels[LABELS.spec] !== spec.labels[LABELS.spec]) {
			await this.runtime.remove(name);
			ingress = undefined;
		}
		if (!ingress) {
			if (!(await this.runtime.hasImage(INGRESS_IMAGE))) await this.runtime.pull(INGRESS_IMAGE);
			await this.runtime.run(spec);
			// a new ingress starts without routes
			this.#applied = null;
		}
		this.#ingressUp = true;
		// the ingress joins every environment network so it can reach (and health-check) services
		const joined = new Set(ingress?.networks ?? [spec.network]);
		for (const network of desired.networks) {
			if (!joined.has(network)) await this.runtime.connect(name, network);
		}
	}
}
