import type { JobReport } from '@tramline/contracts';
import type Docker from 'dockerode';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ContainerRuntime } from './runtime';

/**
 * The agent updating itself. It can't replace its own container while it runs
 * in it, so after pulling a newer image it starts a short-lived helper from
 * that image (`update` mode), which swaps the containers:
 *
 * 1. the old agent is renamed and stopped;
 * 2. a new one starts under the old name, with the same settings and volume;
 * 3. if the new one stays up, the old one is removed; if not, the new one is
 *    removed and the old one renamed back and started again.
 *
 * The outcome is kept in the state volume, which both agents share, so
 * whichever one runs afterwards reports it.
 */

/** The helper's container name; there is only ever one. */
export const HELPER_NAME = 'tramline-agent-update';
/** How long the new agent must stay up before the old one is removed. */
export const STABLE_MS = 15_000;
const PULL_DEADLINE_MS = 10 * 60_000;
const SOCKET = '/var/run/docker.sock';

/** The image this agent's container runs: the reference it was started from, and its ID. */
export interface OwnImage {
	containerId: string;
	reference: string;
	id: string;
	/** The host's Docker socket, as mounted into this container (`/host/path:/var/run/docker.sock`). */
	socketBind: string;
}

interface UpdateRecord {
	id: string;
	state: 'running' | 'restarting' | 'succeeded' | 'failed';
	/** The image the agent ran before; set once the helper takes over. */
	fromImage?: string;
	detail?: string | null;
	error?: string | null;
}

/** `sha256:3f2a9c1b7e04…` → `3f2a9c1b7e04`. */
export const shortImageId = (id: string) => id.replace(/^sha256:/, '').slice(0, 12);

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The ID of the container this process runs in. Docker mounts the
 * container's own `hostname`, `hosts` and `resolv.conf` from a directory
 * named after its ID, which shows in the mount table.
 */
export function ownContainerId(
	mountinfo = '/proc/self/mountinfo',
	env = process.env
): string | null {
	if (env.TRAMLINE_AGENT_CONTAINER) return env.TRAMLINE_AGENT_CONTAINER;
	try {
		return readFileSync(mountinfo, 'utf8').match(/\/containers\/([0-9a-f]{64})\//)?.[1] ?? null;
	} catch {
		return null;
	}
}

/** What this agent's container runs, or null outside a container (or without the socket). */
export async function ownImage(
	docker: Docker,
	containerId: string | null
): Promise<OwnImage | null> {
	if (!containerId) return null;
	try {
		const info = await docker.getContainer(containerId).inspect();
		const socketBind = (info.HostConfig.Binds ?? []).find((b) => b.split(':')[1] === SOCKET);
		if (!socketBind) return null;
		return { containerId: info.Id, reference: info.Config.Image, id: info.Image, socketBind };
	} catch {
		return null;
	}
}

export class SelfUpdater {
	#record: UpdateRecord | null;
	#file: string;
	#log: (message: string) => void;

	constructor(
		private runtime: Pick<ContainerRuntime, 'pull' | 'imageId' | 'run' | 'remove' | 'removeImage'>,
		private options: {
			stateDir: string;
			image: OwnImage | null;
			log?: (message: string) => void;
			/**
			 * How long a freshly updated agent waits before calling the update a
			 * success: until the helper has seen it stay up, after which there's no
			 * going back.
			 */
			settleMs?: number;
		}
	) {
		this.#file = path.join(options.stateDir, 'agent-update.json');
		this.#log = options.log ?? ((message) => console.log(`[agent] ${message}`));
		this.#record = this.#load();
		this.#resume();
	}

	get image() {
		return this.options.image;
	}

	/** The latest update, for the report. */
	get report(): JobReport | null {
		const r = this.#record;
		if (!r) return null;
		return {
			id: r.id,
			state: r.state === 'restarting' ? 'running' : r.state,
			size: null,
			error: r.error ?? null,
			detail: r.detail ?? null
		};
	}

	/** Starts the update the control plane asks for, unless it already ran. */
	want(update: { id: string } | null | undefined) {
		if (!update || update.id === this.#record?.id) return;
		this.#save({ id: update.id, state: 'running', detail: 'Pulling the agent image' });
		void this.#run(update.id).catch((error) => this.#fail(update.id, errorMessage(error)));
	}

	/** Settles an update the previous agent (or this one, before a restart) started. */
	#resume() {
		const r = this.#record;
		if (r?.state === 'running') {
			this.#save({
				...r,
				state: 'failed',
				error: 'The agent restarted before the update finished'
			});
		} else if (r?.state === 'restarting') {
			const now = this.options.image?.id;
			if (now && r.fromImage && now !== r.fromImage) {
				const from = r.fromImage;
				setTimeout(
					() => {
						if (this.#record?.id !== r.id) return;
						this.#save({
							...r,
							state: 'succeeded',
							detail: `Updated from ${shortImageId(from)} to ${shortImageId(now)}`
						});
						this.#log(`updated to ${shortImageId(now)}`);
						// once the mesh and proxies have moved to the new image, the old one is unused
						setTimeout(() => void this.runtime.removeImage(from).catch(() => {}), 120_000).unref();
					},
					this.options.settleMs ?? STABLE_MS + 5_000
				).unref();
			} else {
				this.#save({
					...r,
					state: 'failed',
					error: "The new agent didn't stay up, so the previous one is running again"
				});
			}
		}
	}

	async #run(id: string) {
		const own = this.options.image;
		if (!own) {
			throw new Error(
				"This agent isn't running in a container with the Docker socket, so it can't replace itself. Update it where it was installed."
			);
		}
		if (own.reference.startsWith('sha256:')) {
			throw new Error(
				`It was started from an image ID (${shortImageId(own.reference)}), so there's nothing to pull`
			);
		}
		this.#log(`agent update ${id}: pulling ${own.reference}`);
		await Promise.race([
			this.runtime.pull(own.reference),
			sleep(PULL_DEADLINE_MS, undefined, { ref: false }).then(() => {
				throw new Error(`Pulling ${own.reference} took over 10 minutes`);
			})
		]);
		const latest = await this.runtime.imageId(own.reference);
		if (!latest) throw new Error(`${own.reference} isn't on this machine after pulling it`);
		if (latest === own.id) {
			this.#save({
				id,
				state: 'succeeded',
				detail: `Already up to date (${shortImageId(own.id)})`
			});
			this.#log(`agent update ${id}: already up to date`);
			return;
		}
		this.#save({
			id,
			state: 'restarting',
			fromImage: own.id,
			detail: `Restarting on ${shortImageId(latest)}`
		});
		this.#log(`agent update ${id}: restarting on ${shortImageId(latest)}`);
		await this.runtime.remove(HELPER_NAME);
		await this.runtime.run({
			name: HELPER_NAME,
			image: latest,
			cmd: ['update', own.containerId, latest],
			env: {},
			labels: {},
			network: 'none',
			aliases: [],
			restart: { name: 'no', maxRetries: 0 },
			binds: [own.socketBind],
			autoRemove: true,
			security: {
				capabilities: [],
				pidsLimit: 64,
				memoryMb: 128,
				readOnlyRootFilesystem: true
			}
		});
	}

	#fail(id: string, error: string) {
		this.#log(`agent update ${id} failed: ${error}`);
		this.#save({ id, state: 'failed', error });
	}

	#load(): UpdateRecord | null {
		try {
			return JSON.parse(readFileSync(this.#file, 'utf8')) as UpdateRecord;
		} catch {
			return null;
		}
	}

	#save(record: UpdateRecord) {
		this.#record = record;
		// written whole, then renamed, so a restart never finds half a file
		writeFileSync(`${this.#file}.tmp`, JSON.stringify(record));
		renameSync(`${this.#file}.tmp`, this.#file);
	}
}

type ContainerInfo = Awaited<ReturnType<Docker.Container['inspect']>>;
type ImageConfig = {
	Env?: string[];
	Labels?: Record<string, string> | null;
	User?: string;
	WorkingDir?: string;
};

/**
 * The new agent's container: the old one's name and host settings (socket,
 * volume, restart policy, lockdown) on the new image. Environment variables
 * and labels the old image set itself are left out, so the new image's own
 * apply; so is the join token, which was spent when the node enrolled.
 */
export function recreateSpec(
	old: Pick<ContainerInfo, 'Name' | 'Config' | 'HostConfig'>,
	oldImage: ImageConfig,
	image: string
): Docker.ContainerCreateOptions {
	const imageEnv = new Set(oldImage.Env ?? []);
	const imageLabels = oldImage.Labels ?? {};
	return {
		name: old.Name.replace(/^\//, ''),
		Image: image,
		Hostname: old.Config.Hostname,
		Env: (old.Config.Env ?? []).filter(
			(e) => !imageEnv.has(e) && !e.startsWith('TRAMLINE_JOIN_TOKEN=')
		),
		Labels: Object.fromEntries(
			Object.entries(old.Config.Labels ?? {}).filter(([k, v]) => imageLabels[k] !== v)
		),
		...(old.Config.User && old.Config.User !== oldImage.User ? { User: old.Config.User } : {}),
		HostConfig: old.HostConfig
	};
}

const statusCode = (error: unknown) => (error as { statusCode?: number })?.statusCode;

/**
 * The helper's job (`agent update <old container> <new image>`): swap the
 * old agent's container for one on the new image, rolling back if the new
 * one doesn't stay up for `stableMs`.
 */
export async function swapAgent(
	docker: Docker,
	oldId: string,
	image: string,
	{ stableMs = STABLE_MS, log = (m: string) => console.log(`[update] ${m}`) } = {}
) {
	const oldContainer = docker.getContainer(oldId);
	const old = await oldContainer.inspect();
	const oldImage = await docker.getImage(old.Image).inspect();
	const spec = recreateSpec(old, oldImage.Config, image);
	const name = spec.name!;
	const aside = `${name}-previous`;

	// left by an earlier swap that was cut short; the agent that started this one is `oldId`
	await docker
		.getContainer(aside)
		.inspect()
		.then((stale) =>
			stale.Id === old.Id ? null : docker.getContainer(stale.Id).remove({ force: true })
		)
		.catch(() => {});

	log(`stopping ${name}`);
	await oldContainer.rename({ name: aside });
	try {
		await oldContainer.stop({ t: 30 });
	} catch (error) {
		if (statusCode(error) !== 304) throw error;
	}

	let created: Docker.Container | null = null;
	try {
		created = await docker.createContainer(spec);
		await created.start();
		log(`started ${name} on ${shortImageId(image)}; checking it stays up`);
		for (let waited = 0; waited < stableMs; waited += 1_000) {
			await sleep(Math.min(1_000, stableMs));
			const state = await created.inspect();
			if (!state.State.Running || state.RestartCount > 0) {
				throw new Error(`the new agent stopped (exit code ${state.State.ExitCode})`);
			}
		}
	} catch (error) {
		log(`${errorMessage(error)}; going back to the previous agent`);
		if (created) await created.remove({ force: true }).catch(() => {});
		await oldContainer.rename({ name });
		await oldContainer.start();
		throw error;
	}
	await oldContainer.remove({ force: true });
	log(`done`);
}
