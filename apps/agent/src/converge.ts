import type { DesiredState } from '@tramline/contracts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { INGRESS_CONFIG_PATH, INGRESS_IMAGE, INGRESS_NAME, caddyConfig } from './caddy';
import { LABELS, type ContainerRuntime } from './runtime';
import { hash, toRunSpec } from './spec';

export interface ConvergeOptions {
	/** Host directory for agent state; the ingress config is written under it. */
	stateDir: string;
	log?: (message: string) => void;
}

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

	#running: Promise<void> | null = null;
	#again = false;
	#latest: DesiredState | null = null;

	constructor(
		private runtime: ContainerRuntime,
		private options: ConvergeOptions
	) {}

	/** Converges to `desired`; overlapping calls coalesce into one follow-up run. */
	async run(desired: DesiredState): Promise<void> {
		this.#latest = desired;
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
		const log = this.options.log ?? (() => {});
		for (const network of desired.networks) await this.runtime.ensureNetwork(network);

		const wanted = new Map(desired.containers.map((c) => [c.name, toRunSpec(c)]));
		const existing = await this.runtime.list();
		const present = new Set<string>();

		for (const container of existing) {
			if (container.labels[LABELS.role] === 'ingress') continue;
			const spec = wanted.get(container.name);
			if (spec && spec.labels[LABELS.spec] === container.labels[LABELS.spec]) {
				present.add(container.name);
				continue;
			}
			log(`removing ${container.name}`);
			await this.runtime.remove(container.name);
		}

		for (const name of this.errors.keys()) if (!wanted.has(name)) this.errors.delete(name);

		for (const [name, spec] of wanted) {
			if (present.has(name) || this.errors.has(name)) continue;
			try {
				if (!(await this.runtime.hasImage(spec.image))) {
					this.pulling.add(name);
					log(`pulling ${spec.image}`);
					await this.runtime.pull(spec.image);
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

		if (desired.networks.length) await this.#ensureIngress(desired, existing);
	}

	async #ensureIngress(
		desired: DesiredState,
		existing: Awaited<ReturnType<ContainerRuntime['list']>>
	) {
		const dir = path.join(this.options.stateDir, 'caddy');
		const file = path.join(dir, 'caddy.json');
		const config = JSON.stringify(caddyConfig(desired.ingress), null, 2);
		mkdirSync(dir, { recursive: true });
		let current: string | null = null;
		try {
			current = readFileSync(file, 'utf8');
		} catch {
			// first run
		}
		// Caddy runs with --watch, so rewriting the file reloads it without dropping connections
		if (current !== config) writeFileSync(file, config);

		const spec = {
			name: INGRESS_NAME,
			image: INGRESS_IMAGE,
			cmd: ['caddy', 'run', '--config', INGRESS_CONFIG_PATH, '--watch'],
			env: {},
			network: desired.networks[0]!,
			aliases: [],
			restart: { name: 'always' as const, maxRetries: 0 },
			ports: [
				{ container: 80, host: desired.ingress.httpPort },
				...(desired.ingress.tls ? [{ container: 443, host: 443 }] : [])
			],
			binds: [`${path.resolve(dir)}:${path.dirname(INGRESS_CONFIG_PATH)}:ro`],
			labels: {
				[LABELS.managed]: 'true',
				[LABELS.role]: 'ingress',
				[LABELS.spec]: hash({ port: desired.ingress.httpPort, tls: desired.ingress.tls, dir })
			}
		};

		let ingress = existing.find((c) => c.name === INGRESS_NAME);
		if (ingress && ingress.labels[LABELS.spec] !== spec.labels[LABELS.spec]) {
			await this.runtime.remove(INGRESS_NAME);
			ingress = undefined;
		}
		if (!ingress) {
			if (!(await this.runtime.hasImage(INGRESS_IMAGE))) await this.runtime.pull(INGRESS_IMAGE);
			await this.runtime.run(spec);
		}
		// the ingress joins every environment network so it can reach (and health-check) services
		const joined = new Set(ingress?.networks ?? [spec.network]);
		for (const network of desired.networks) {
			if (!joined.has(network)) await this.runtime.connect(INGRESS_NAME, network);
		}
	}
}
