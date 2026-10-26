import {
	AGENT_PROTOCOL_VERSION,
	type AgentHello,
	type BuildReport,
	type DesiredState,
	type JobReport
} from '@tramline/contracts';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { Backups } from './backups';
import { runQuery } from './query';
import { Builder, type BuilderOptions } from './builder';
import { ControlPlaneError, type ControlPlane } from './client';
import { Converger } from './converge';
import { meshKeys } from './mesh';
import { HealthChecker } from './health';
import { LogShipper } from './logs';
import type { ContainerRuntime, ManagedContainer } from './runtime';
import { observe } from './state';

export interface AgentOptions {
	runtime: ContainerRuntime;
	client: Pick<ControlPlane, 'hello' | 'desired' | 'report' | 'logs'> &
		Partial<Pick<ControlPlane, 'answer'>>;
	stateDir: string;
	version: string;
	reportIntervalMs?: number;
	/** Re-converge this often even without changes, to repair drift (e.g. a container removed by hand). */
	healIntervalMs?: number;
	/** Called when the control plane rejects the token, e.g. to re-read a rotated token file. */
	onUnauthorized?: () => void;
	/** Wait this long before retrying after a rejected token. */
	unauthorizedBackoffMs?: number;
	/** For downloads (build tools) and backup uploads; tests pass a fake. */
	fetcher?: typeof fetch;
	/** Fetches a verified build tool binary; tests pass a fake. */
	tools?: BuilderOptions['tools'];
	log?: (message: string) => void;
	/**
	 * Join the WireGuard mesh: the image the mesh container runs and where
	 * other nodes reach this one (`host:port`, UDP; null behind NAT). The key
	 * pair is created in the state directory.
	 */
	mesh?: { image: string; endpoint: string | null };
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
	readonly builder: Builder;
	/** Builds this agent has started, by deployment, until the control plane stops asking for them. */
	readonly builds = new Map<string, BuildReport>();
	readonly backups: Backups;
	/** Backups and restores this agent has started, until the control plane stops asking for them. */
	readonly jobs = {
		backup: new Map<string, JobReport>(),
		restore: new Map<string, JobReport>(),
		drill: new Map<string, JobReport>()
	};
	/**
	 * Builds run one at a time, and so do image scans, but a scan never waits
	 * for a long build. Backups and restores share a queue of their own.
	 */
	#queues = { build: Promise.resolve(), scan: Promise.resolve(), data: Promise.resolve() };

	/** Data browser queries already answered (or being answered), until the control plane drops them. */
	#queries = new Set<string>();
	#abort = new AbortController();
	#lastHeal = 0;
	#log: (message: string) => void;
	#meshPublicKey: string | null;

	constructor(private options: AgentOptions) {
		this.#log = options.log ?? ((message) => console.log(`[agent] ${message}`));
		const keys = options.mesh ? meshKeys(options.stateDir) : null;
		this.#meshPublicKey = keys?.publicKey ?? null;
		this.converger = new Converger(options.runtime, {
			log: this.#log,
			mesh: options.mesh && keys ? { ...options.mesh, privateKey: keys.privateKey } : undefined
		});
		this.health = new HealthChecker(options.runtime, () => this.converger.ingressName);
		this.logs = new LogShipper(options.runtime, (lines) => options.client.logs(lines));
		this.builder = new Builder(options.runtime, {
			stateDir: options.stateDir,
			nodeId: () => {
				if (!this.converger.nodeId) throw new Error('nodeId is not known yet');
				return this.converger.nodeId;
			},
			onLine: (deploymentId, line) =>
				this.logs.push({ deploymentId, ts: new Date().toISOString(), stream: 'build', line }),
			fetcher: options.fetcher,
			tools: options.tools,
			log: this.#log
		});
		this.backups = new Backups(options.runtime, {
			stateDir: options.stateDir,
			nodeId: () => {
				if (!this.converger.nodeId) throw new Error('nodeId is not known yet');
				return this.converger.nodeId;
			},
			hold: (names) => names.forEach((name) => this.converger.held.add(name)),
			fetcher: options.fetcher,
			release: (names) => {
				names.forEach((name) => this.converger.held.delete(name));
				if (names.length && this.desired) void this.converger.run(this.desired);
			},
			log: this.#log
		});
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
				const { nodeId } = await this.options.client.hello(await this.describe());
				this.converger.nodeId = nodeId;
				return;
			} catch (error) {
				await this.#backoff('hello', error);
				if (this.stopped) throw error;
			}
		}
	}

	/** What the agent tells the control plane about this machine. */
	async describe(): Promise<AgentHello> {
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
			dockerError: this.dockerError,
			mesh: this.#meshPublicKey
				? { publicKey: this.#meshPublicKey, endpoint: this.options.mesh?.endpoint ?? null }
				: null
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
			this.#startBuilds(next);
			this.#answerQueries(next);
			await this.converger.run(next);
			this.#lastHeal = Date.now();
		}
	}

	/** Queues the builds and image scans the control plane wants, and forgets ones it has moved past. */
	#startBuilds(desired: DesiredState) {
		const jobs = [
			...desired.builds.map((job) => ({
				id: job.deploymentId,
				queue: 'build' as const,
				run: () => this.builder.build(job)
			})),
			...desired.scans.map((job) => ({
				id: job.deploymentId,
				queue: 'scan' as const,
				run: () => this.builder.scanImage(job)
			}))
		];
		const wanted = new Set(jobs.map((job) => job.id));
		for (const [id, build] of this.builds) {
			if (!wanted.has(id) && build.state !== 'running') this.builds.delete(id);
		}
		for (const job of jobs) {
			if (this.builds.has(job.id)) continue;
			this.builds.set(job.id, {
				deploymentId: job.id,
				state: 'running',
				image: null,
				commit: null,
				error: null
			});
			this.#queues[job.queue] = this.#queues[job.queue].then(async () => {
				// it may have been cancelled (e.g. removed) while waiting its turn
				const current = this.desired;
				if (
					!current?.builds.some((b) => b.deploymentId === job.id) &&
					!current?.scans.some((b) => b.deploymentId === job.id)
				) {
					this.builds.delete(job.id);
					return;
				}
				this.#log(`${job.queue} ${job.id}`);
				const result = await job.run();
				this.#log(`${job.queue} ${job.id} ${result.state}`);
				this.builds.set(job.id, result);
			});
		}
	}

	/**
	 * Queues backups or restores the control plane wants, one at a time, and
	 * forgets finished ones it has moved past. Jobs whose presigned URL hasn't
	 * arrived yet wait for the next state.
	 */
	#startJobs<T extends { id: string; url: string | null }>(
		kind: 'backup' | 'restore' | 'drill',
		wanted: T[],
		run: (job: T) => Promise<JobReport>
	) {
		const reports = this.jobs[kind];
		const ids = new Set(wanted.map((job) => job.id));
		for (const [id, report] of reports) {
			if (!ids.has(id) && report.state !== 'running') reports.delete(id);
		}
		for (const job of wanted) {
			if (reports.has(job.id)) continue;
			reports.set(job.id, { id: job.id, state: 'running', size: null, error: null, detail: null });
			this.#queues.data = this.#queues.data.then(async () => {
				const current = this.desired?.[
					kind === 'backup' ? 'backups' : kind === 'restore' ? 'restores' : 'drills'
				] as T[] | undefined;
				const latest = current?.find((j) => j.id === job.id);
				if (!latest) {
					reports.delete(job.id);
					return;
				}
				this.#log(`${kind} ${job.id}`);
				const result = await run(latest);
				this.#log(`${kind} ${job.id} ${result.state}${result.error ? `: ${result.error}` : ''}`);
				reports.set(job.id, result);
			});
		}
	}

	/** Runs new data browser queries straight away; they are small and read-only. */
	#answerQueries(desired: DesiredState) {
		const wanted = new Set(desired.queries.map((q) => q.id));
		for (const id of this.#queries) if (!wanted.has(id)) this.#queries.delete(id);
		for (const query of desired.queries) {
			if (this.#queries.has(query.id)) continue;
			this.#queries.add(query.id);
			void runQuery(this.options.runtime, query)
				.then((result) => this.options.client.answer?.(query.id, result))
				.catch((error) => this.#log(`query ${query.id}: ${errorMessage(error)}`));
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
		let volumes: string[] | undefined;
		if (desired && !this.dockerError) {
			const heal = Date.now() - this.#lastHeal >= (this.options.healIntervalMs ?? 15_000);
			if (heal || this.converger.removalDue) {
				this.#lastHeal = Date.now();
				await this.converger.run(desired);
				containers = this.converger.owned(await this.options.runtime.list());
			}
			await this.health.check(desired, containers);
			this.logs.sync(containers);
			this.#startBuilds(desired);
			this.#startJobs('backup', desired.backups, (job) => this.backups.backup(job));
			this.#startJobs('restore', desired.restores, (job) => this.backups.restore(job));
			this.#startJobs('drill', desired.drills, (job) => this.backups.drill(job));
			volumes = await this.converger.volumes().catch(() => undefined);
		}

		await this.options.client.report({
			containers:
				desired && !this.dockerError
					? observe(desired, containers, this.converger, this.health)
					: [],
			builds: [...this.builds.values()],
			backups: [...this.jobs.backup.values()],
			restores: [...this.jobs.restore.values()],
			drills: [...this.jobs.drill.values()],
			volumes,
			revision: desired?.revision ?? null,
			dockerError: this.dockerError
		});
	}
}
