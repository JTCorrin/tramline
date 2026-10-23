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
	/** Called when the control plane rejects the token, e.g. to re-read a rotated token file. */
	onUnauthorized?: () => void;
	/** Wait this long before retrying after a rejected token. */
	unauthorizedBackoffMs?: number;
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
		this.health = new HealthChecker(options.runtime, () => this.converger.ingressName);
		this.logs = new LogShipper(options.runtime, (lines) => options.client.logs(lines));
	}

	get stopped() {
		return this.#abort.signal.aborted;
	}

	async start() {
		await this.hello();
		// long-polls normally wait server-side; the floor stops a misbehaving server from causing a busy loop
		void this.#loop('sync', () => this.sync(), 100);
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
				await this.#backoff(name, error);
			}
		}
	}

	/**
	 * Waits before retrying. A rejected token is never fatal: it may have been
	 * rotated (so re-read it), or the control plane may be briefly misbehaving.
	 */
	async #backoff(step: string, error: unknown) {
		let wait = 2_000;
		if (error instanceof ControlPlaneError && error.status === 401) {
			this.#log(
				`${step}: the control plane rejected this agent's token; retrying with a fresh read`
			);
			this.options.onUnauthorized?.();
			wait = this.options.unauthorizedBackoffMs ?? 30_000;
		} else {
			this.#log(`${step}: ${errorMessage(error)}`);
		}
		await sleep(wait, undefined, { signal: this.#abort.signal }).catch(() => {});
	}

	/** Registers with the control plane, retrying until it is reachable. */
	async hello() {
		for (;;) {
			try {
				const { nodeId } = await this.options.client.hello(await this.#describe());
				this.converger.nodeId = nodeId;
				return;
			} catch (error) {
				await this.#backoff('hello', error);
				if (this.stopped) throw error;
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
			containers = this.converger.owned(await this.options.runtime.list());
			if (this.dockerError) {
				this.#log('Docker is back');
				await this.hello();
			}
		} catch (error) {
			if (!this.dockerError) {
				this.dockerError = `Docker is unavailable: ${errorMessage(error)}`;
				this.#log(this.dockerError);
			}
		}

		const desired = this.desired;
		if (desired && !this.dockerError) {
			const heal = Date.now() - this.#lastHeal >= (this.options.healIntervalMs ?? 15_000);
			if (heal || this.converger.removalDue) {
				this.#lastHeal = Date.now();
				await this.converger.run(desired);
				containers = this.converger.owned(await this.options.runtime.list());
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
