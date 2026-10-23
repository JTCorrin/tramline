import { AGENT_PROTOCOL_VERSION, type AgentHello, type DesiredState } from '@tramline/contracts';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { ControlPlaneError, type ControlPlane } from './client';
import { Converger } from './converge';
import { HealthChecker } from './health';
import { LogShipper } from './logs';
import type { ContainerRuntime, ManagedContainer } from './runtime';
import { observe } from './state';

export interface AgentOptions {
	runtime: ContainerRuntime;
	client: Pick<ControlPlane, 'hello' | 'desired' | 'report' | 'logs'>;
	stateDir: string;
	version: string;
	reportIntervalMs?: number;
	/** Re-converge this often even without changes, to repair drift (e.g. a container removed by hand). */
	healIntervalMs?: number;
	log?: (message: string) => void;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The node agent: three loops sharing one desired state.
 *
 * - sync: long-polls the control plane for desired state and converges to it
 * - report: observes containers, runs healthchecks, reports actual state
 * - logs: ships container logs in batches
 */
export class Agent {
	desired: DesiredState | null = null;
	dockerError: string | null = null;
	readonly converger: Converger;
	readonly health: HealthChecker;
	readonly logs: LogShipper;

	#abort = new AbortController();
	#lastHeal = 0;
	#log: (message: string) => void;

	constructor(private options: AgentOptions) {
		this.#log = options.log ?? ((message) => console.log(`[agent] ${message}`));
		this.converger = new Converger(options.runtime, { stateDir: options.stateDir, log: this.#log });
		this.health = new HealthChecker(options.runtime);
		this.logs = new LogShipper(options.runtime, (lines) => options.client.logs(lines));
	}

	get stopped() {
		return this.#abort.signal.aborted;
	}

	async start() {
		await this.hello();
		void this.#loop('sync', () => this.sync(), 0);
		void this.#loop('report', () => this.tick(), this.options.reportIntervalMs ?? 2_000);
		void this.#loop('logs', () => this.logs.flush(), 500);
	}

	stop() {
		this.#abort.abort();
		this.logs.stop();
	}

	async #loop(name: string, step: () => Promise<unknown>, every: number) {
		while (!this.stopped) {
			try {
				await step();
				if (every) await sleep(every, undefined, { signal: this.#abort.signal });
			} catch (error) {
				if (this.stopped) return;
				if (error instanceof ControlPlaneError && error.status === 401) {
					this.#log('the control plane rejected this agent token; stopping');
					return this.stop();
				}
				this.#log(`${name}: ${errorMessage(error)}`);
				await sleep(2_000, undefined, { signal: this.#abort.signal }).catch(() => {});
			}
		}
	}

	/** Registers with the control plane, retrying until it is reachable. */
	async hello() {
		for (;;) {
			try {
				await this.options.client.hello(await this.#describe());
				return;
			} catch (error) {
				if (error instanceof ControlPlaneError && error.status === 401) throw error;
				this.#log(`waiting for the control plane: ${errorMessage(error)}`);
				await sleep(2_000, undefined, { signal: this.#abort.signal });
			}
		}
	}

	async #describe(): Promise<AgentHello> {
		let docker: AgentHello['docker'] = null;
		try {
			docker = { version: await this.options.runtime.version() };
			this.dockerError = null;
		} catch (error) {
			this.dockerError = `Docker is unavailable: ${errorMessage(error)}`;
		}
		return {
			protocol: AGENT_PROTOCOL_VERSION,
			agentVersion: this.options.version,
			hostname: os.hostname(),
			os: os.platform(),
			arch: os.arch(),
			cpus: os.cpus().length,
			memoryMb: Math.round(os.totalmem() / 1024 / 1024),
			docker,
			dockerError: this.dockerError
		};
	}

	/** One long-poll; converges if the desired state changed. */
	async sync() {
		const next = await this.options.client.desired(
			this.desired?.revision ?? null,
			this.#abort.signal
		);
		if (!next) return;
		this.desired = next;
		if (!this.dockerError) {
			await this.converger.run(next);
			this.#lastHeal = Date.now();
		}
	}

	/** One report cycle. */
	async tick() {
		let containers: ManagedContainer[] = [];
		try {
			containers = await this.options.runtime.list();
			if (this.dockerError) {
				this.#log('Docker is back');
				await this.options.client.hello(await this.#describe());
			}
		} catch (error) {
			if (!this.dockerError) {
				this.dockerError = `Docker is unavailable: ${errorMessage(error)}`;
				this.#log(this.dockerError);
			}
		}

		const desired = this.desired;
		if (desired && !this.dockerError) {
			if (Date.now() - this.#lastHeal >= (this.options.healIntervalMs ?? 15_000)) {
				this.#lastHeal = Date.now();
				await this.converger.run(desired);
				containers = await this.options.runtime.list();
			}
			await this.health.check(desired, containers);
			this.logs.sync(containers);
		}

		await this.options.client.report({
			containers:
				desired && !this.dockerError
					? observe(desired, containers, this.converger, this.health)
					: [],
			revision: desired?.revision ?? null,
			dockerError: this.dockerError
		});
	}
}
