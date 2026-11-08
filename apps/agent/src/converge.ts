import type {
	Containment,
	DesiredContainer,
	DesiredState,
	SecurityCount,
	SecurityKind
} from '@tramline/contracts';
import { INGRESS_CONFIG_PATH, INGRESS_IMAGE, caddyConfig, ingressName } from './caddy';
import {
	MESH_CONFIG_PATH,
	meshAlias,
	meshContainerName,
	meshNetworkName,
	type MeshConfig
} from './mesh';
import { SOCAT_IMAGE } from './pins';
import { LABELS, type ContainerRuntime, type ManagedContainer, type RunSpec } from './runtime';
import type { Certificate } from './tls';

/** Where a database finds its TLS certificate and key. */
export const TLS_DIR = '/etc/tramline/tls';
import {
	FIREWALL_CONFIG_PATH,
	FIREWALL_STATUS_PATH,
	firewallName,
	type ContainerCounters,
	type FirewallConfig,
	type FirewallStatus
} from './firewall';
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
	/** This node's WireGuard identity and the image its mesh container runs. */
	mesh?: { image: string; privateKey: string; endpoint: string | null };
	/** The agent's own image, which TCP proxies run; without it there are none. */
	agentImage?: string;
	/**
	 * The image the firewall container runs (the agent's), which contains
	 * service containers; without it they aren't contained.
	 */
	firewall?: { image: string };
	/** A service's TLS certificate, created and kept on this node. */
	certificates?: (id: string, names: string[]) => Certificate;
}

export const DEFAULT_DRAIN_MS = 10_000;

/**
 * New connections a minute past which a container counts as scanning: far
 * more than an app opens, even a busy one with no connection reuse.
 */
export const SCAN_CONNECTIONS_PER_MINUTE = 600;

/** A container that failed to start is retried after this, doubling up to RETRY_MAX_MS. */
export const RETRY_FIRST_MS = 10_000;
export const RETRY_MAX_MS = 5 * 60_000;

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
	/** When a container that failed to start is tried again, and for which spec. */
	#retries = new Map<string, { at: number; attempts: number; spec: string }>();
	/** The mesh config last written into the mesh container. */
	#meshApplied: string | null = null;
	/** The firewall config last written into the firewall container. */
	#firewallApplied: string | null = null;
	#firewallAsked = 0;
	/** What the firewall container last said, for the report. */
	containment: Containment = { state: 'starting', detail: null };
	/** The firewall's counters at the last look, to tell what changed. */
	#counters: {
		generation: string | undefined;
		at: number;
		counters: Record<string, ContainerCounters>;
	} | null = null;
	/** Blocked attempts and scans not reported yet, by container and kind. */
	#security = new Map<string, SecurityCount>();

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
		// before anything starts on a new network, so no container runs uncontained
		await this.#ensureFirewall(desired).catch((error) =>
			log(`containment failed: ${error instanceof Error ? error.message : String(error)}`)
		);

		const wanted = new Map(desired.containers.map((c) => [c.name, toRunSpec(c, nodeId)]));
		const tls = new Map(desired.containers.map((c) => [c.name, c]));
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

		for (const name of this.errors.keys()) {
			// gone, or changed: a new spec deserves a fresh try
			const retry = this.#retries.get(name);
			if (!wanted.has(name) || retry?.spec !== wanted.get(name)!.labels[LABELS.spec]) {
				this.errors.delete(name);
				this.#retries.delete(name);
			}
		}

		// 1. start what's missing
		const now = this.#now();
		for (const [name, spec] of wanted) {
			if (present.has(name) || this.held.has(name)) continue;
			// a failed start is tried again later (a registry or Docker hiccup passes)
			if (this.errors.has(name) && now < (this.#retries.get(name)?.at ?? 0)) continue;
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
				await this.runtime.run(this.#withTls(spec, tls.get(name)!));
				this.errors.delete(name);
				this.#retries.delete(name);
			} catch (error) {
				this.errors.set(name, error instanceof Error ? error.message : String(error));
				const attempts = (this.#retries.get(name)?.attempts ?? 0) + 1;
				this.#retries.set(name, {
					attempts,
					at: now + Math.min(RETRY_FIRST_MS * 2 ** (attempts - 1), RETRY_MAX_MS),
					spec: spec.labels[LABELS.spec]!
				});
				log(`failed to start ${name}: ${this.errors.get(name)}`);
			} finally {
				this.pulling.delete(name);
			}
		}

		// 2. reach services on other nodes, then point routes at the new deployments
		// (and drop routes to removed ones, even the last)
		try {
			await this.#ensureMesh(desired, existing);
		} catch (error) {
			// this node's own services and routes don't depend on the mesh
			log(`the mesh failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			await this.#ensureTcpProxies(desired, existing);
		} catch (error) {
			log(`a TCP proxy failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			await this.#ensureTunnel(desired, existing);
		} catch (error) {
			log(`the tunnel connector failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (desired.networks.length) await this.#ensureIngress(desired, existing);
		await this.#publishRoutes(desired);
		// again, now the ingress, the mesh and new containers have addresses
		await this.#ensureFirewall(desired).catch((error) =>
			log(`containment failed: ${error instanceof Error ? error.message : String(error)}`)
		);

		// 3. only then drain and remove what is no longer wanted
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

	/**
	 * One container per TCP proxy, each publishing its own edge port, so
	 * adding or changing one never interrupts another.
	 */
	async #ensureTcpProxies(desired: DesiredState, existing: ManagedContainer[]) {
		const nodeId = this.#node();
		const image = this.options.agentImage;
		const wanted = new Map(
			(image ? (desired.tcpProxies ?? []) : []).map((proxy) => {
				const spec: RunSpec = {
					name: proxy.name,
					image: image!,
					cmd: [
						'proxy',
						JSON.stringify({
							listen: proxy.port,
							target: proxy.target,
							allow: proxy.allow,
							protocol: proxy.protocol
						})
					],
					env: {},
					network: proxy.network,
					aliases: [],
					restart: { name: 'always', maxRetries: 0 },
					ports: [{ container: proxy.port, host: proxy.port }],
					security: {
						capabilities: [],
						pidsLimit: 128,
						memoryMb: 128,
						readOnlyRootFilesystem: true
					},
					labels: {
						[LABELS.managed]: 'true',
						[LABELS.node]: nodeId,
						[LABELS.role]: 'tcp-proxy',
						[LABELS.spec]: hash({ proxy, image })
					}
				};
				return [proxy.name, spec];
			})
		);
		const current = existing.filter((c) => c.labels[LABELS.role] === 'tcp-proxy');
		for (const container of current) {
			if (wanted.get(container.name)?.labels[LABELS.spec] !== container.labels[LABELS.spec]) {
				await this.runtime.remove(container.name);
			}
		}
		const present = new Set(
			current
				.filter((c) => wanted.get(c.name)?.labels[LABELS.spec] === c.labels[LABELS.spec])
				.map((c) => c.name)
		);
		for (const [name, spec] of wanted) {
			if (present.has(name)) continue;
			if (!(await this.runtime.hasImage(spec.image))) await this.runtime.pull(spec.image);
			await this.runtime.run(spec);
		}
	}

	/**
	 * Gives a database its TLS certificate (one per service, kept on this
	 * node) and starts it with TLS on. The spec hash doesn't change, since
	 * the certificate is the node's business.
	 */
	#withTls(spec: RunSpec, container: DesiredContainer): RunSpec {
		if (!container.tls) return spec;
		const certificates = this.options.certificates;
		if (!certificates) throw new Error('This agent cannot create TLS certificates');
		const { cert, key } = certificates(
			`${container.environmentId}-${container.serviceId}`,
			container.tls.names
		);
		// the official image runs Postgres as uid 999; its key must be that user's alone
		const owner = { uid: 999, gid: 999 };
		return {
			...spec,
			// a start command set by the user wins; they can add the same flags
			cmd: spec.cmd ?? [
				'postgres',
				'-c',
				'ssl=on',
				'-c',
				`ssl_cert_file=${TLS_DIR}/server.crt`,
				'-c',
				`ssl_key_file=${TLS_DIR}/server.key`
			],
			files: [
				{ path: `${TLS_DIR}/server.crt`, content: Buffer.from(cert), mode: 0o644, ...owner },
				{ path: `${TLS_DIR}/server.key`, content: Buffer.from(key), mode: 0o600, ...owner }
			]
		};
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

	/**
	 * The mesh container (WireGuard and the TCP forwards, see mesh-daemon.ts)
	 * and one link per service on another node that this node's environments
	 * use. Without a mesh, both are removed.
	 */
	async #ensureMesh(desired: DesiredState, existing: ManagedContainer[]) {
		const log = this.options.log ?? quiet;
		const nodeId = this.#node();
		const name = meshContainerName(nodeId);
		const network = meshNetworkName(nodeId);
		const mesh = this.options.mesh && desired.mesh ? desired.mesh : null;
		const owned = (role: string) => existing.filter((c) => c.labels[LABELS.role] === role);

		const links = new Map(
			(mesh?.links ?? []).map((link) => {
				const spec: RunSpec = {
					name: link.name,
					image: SOCAT_IMAGE,
					cmd: [
						`TCP-LISTEN:${link.port},fork,reuseaddr`,
						`TCP:${meshAlias(nodeId)}:${link.meshPort}`
					],
					env: {},
					network: link.network,
					aliases: [link.alias],
					restart: { name: 'always', maxRetries: 0 },
					security: {
						capabilities: link.port < 1024 ? ['NET_BIND_SERVICE'] : [],
						pidsLimit: 256,
						memoryMb: 64,
						readOnlyRootFilesystem: true
					},
					labels: {
						[LABELS.managed]: 'true',
						[LABELS.node]: nodeId,
						[LABELS.role]: 'link',
						[LABELS.spec]: hash({ link, image: SOCAT_IMAGE })
					}
				};
				return [link.name, spec];
			})
		);
		for (const container of owned('link')) {
			if (links.get(container.name)?.labels[LABELS.spec] !== container.labels[LABELS.spec]) {
				await this.runtime.remove(container.name);
			}
		}

		const current = owned('mesh').find((c) => c.name === name);
		if (!mesh) {
			if (current) {
				log('leaving the mesh');
				await this.runtime.remove(name);
			}
			this.#meshApplied = null;
			return;
		}

		const image = this.options.mesh!.image;
		const hostPort = Number(this.options.mesh!.endpoint?.split(':').at(-1)) || mesh.listenPort;
		const spec: RunSpec = {
			name,
			image,
			cmd: ['mesh'],
			env: {},
			network,
			aliases: [meshAlias(nodeId)],
			restart: { name: 'always', maxRetries: 0 },
			ports: [{ container: mesh.listenPort, host: hostPort, protocol: 'udp' }],
			// relaying passes packets between peers, inside this container's namespace only
			sysctls: { 'net.ipv4.ip_forward': '1' },
			security: {
				capabilities: ['NET_ADMIN'],
				pidsLimit: 256,
				memoryMb: 256,
				readOnlyRootFilesystem: false
			},
			labels: {
				[LABELS.managed]: 'true',
				[LABELS.node]: nodeId,
				[LABELS.role]: 'mesh',
				[LABELS.spec]: hash({ image, port: mesh.listenPort, hostPort, alias: meshAlias(nodeId) })
			}
		};
		let running = current;
		if (running && running.labels[LABELS.spec] !== spec.labels[LABELS.spec]) {
			await this.runtime.remove(name);
			running = undefined;
		}
		if (!running) {
			if (!(await this.runtime.hasImage(image))) await this.runtime.pull(image);
			log('joining the mesh');
			await this.runtime.run(spec);
			this.#meshApplied = null;
		}
		// it delivers to services on this node through their environment networks
		const joined = new Set(running?.networks ?? [network]);
		for (const f of mesh.forwards) {
			if (f.to === 'local' && !joined.has(f.network)) {
				await this.runtime.connect(name, f.network);
				joined.add(f.network);
			}
		}

		const transitAddress = (await this.runtime.addresses(name))[network];
		if (!transitAddress) throw new Error(`the mesh container has no address on ${network}`);
		const { links: _links, ...rest } = mesh;
		const config = JSON.stringify(
			{ ...rest, privateKey: this.options.mesh!.privateKey, transitAddress } satisfies MeshConfig,
			null,
			2
		);
		if (config !== this.#meshApplied) {
			await this.runtime.putFile(name, MESH_CONFIG_PATH, Buffer.from(config), 0o600);
			this.#meshApplied = config;
		}

		const present = new Set(
			owned('link')
				.filter((c) => links.get(c.name)?.labels[LABELS.spec] === c.labels[LABELS.spec])
				.map((c) => c.name)
		);
		for (const [linkName, linkSpec] of links) {
			if (present.has(linkName)) continue;
			if (!(await this.runtime.hasImage(SOCAT_IMAGE))) await this.runtime.pull(SOCAT_IMAGE);
			await this.runtime.run(linkSpec);
			// links reach the mesh container over the mesh network
			await this.runtime.connect(linkName, network);
		}
	}

	/**
	 * The firewall container, and the config it keeps on the host: which
	 * networks are contained, which of Tramline's own containers on them
	 * aren't, and which private ranges a service may reach.
	 */
	async #ensureFirewall(desired: DesiredState) {
		const name = firewallName(this.#node());
		const image = this.options.firewall?.image;
		if (!image) {
			this.containment = {
				state: 'off',
				detail: 'TRAMLINE_CONTAINMENT=off, so service containers can reach the LAN and the host'
			};
			return;
		}
		const subnets = async (networks: string[]) =>
			(await Promise.all(networks.map((n) => this.runtime.networkSubnet(n)))).filter(
				(s): s is string => !!s
			);
		const addresses = (container: string) =>
			this.runtime.addresses(container).catch((): Record<string, string> => ({}));
		const onNetworks = async (container: string) =>
			Object.entries(await addresses(container))
				.filter(([network]) => environments.includes(network))
				.map(([, ip]) => ip);
		// each running service container's address on its network, to count and to open for
		const placed = (
			await Promise.all(
				desired.containers.map(async (c) => ({ c, ip: (await addresses(c.name))[c.network] }))
			)
		).filter((p): p is { c: DesiredContainer; ip: string } => !!p.ip);
		// the mesh network only carries Tramline's own containers: links, the ingress and the mesh
		const environments = desired.networks.filter((n) => n !== meshNetworkName(this.#node()));
		const config: FirewallConfig = {
			workloads: await subnets(environments),
			// builds run the repository's own steps on Docker's default network
			metadataOnly: await subnets(['bridge']),
			exempt: [
				...(await onNetworks(this.ingressName)),
				...(await onNetworks(meshContainerName(this.#node())))
			].sort(),
			allow: placed
				.filter(({ c }) => c.privateNetworks?.length)
				.map(({ c, ip }) => ({ source: ip, destinations: c.privateNetworks! })),
			containers: placed.map(({ c, ip }) => ({ name: c.name, ip }))
		};

		const containers = await this.runtime.list();
		const current = containers.find((c) => c.name === name);
		const spec: RunSpec = {
			name,
			image,
			cmd: ['firewall'],
			env: {},
			network: 'host',
			aliases: [],
			restart: { name: 'always', maxRetries: 0 },
			security: {
				capabilities: ['NET_ADMIN', 'NET_RAW'],
				pidsLimit: 64,
				memoryMb: 128,
				// iptables keeps a lock file under /run
				readOnlyRootFilesystem: false
			},
			labels: {
				[LABELS.managed]: 'true',
				[LABELS.node]: this.#node(),
				[LABELS.role]: 'firewall',
				[LABELS.spec]: hash({ image, mode: 'firewall' })
			}
		};
		if (current && current.labels[LABELS.spec] !== spec.labels[LABELS.spec]) {
			await this.runtime.remove(name);
		}
		if (!current || current.labels[LABELS.spec] !== spec.labels[LABELS.spec]) {
			if (!(await this.runtime.hasImage(image))) await this.runtime.pull(image);
			await this.runtime.run(spec);
			this.#firewallApplied = null;
		}
		const text = JSON.stringify(config);
		if (text !== this.#firewallApplied) {
			await this.runtime.putFile(name, FIREWALL_CONFIG_PATH, Buffer.from(text), 0o600);
			this.#firewallApplied = text;
		}
		// what it said last, now and then
		if (this.#now() - this.#firewallAsked > 10_000 || this.containment.state === 'starting') {
			this.#firewallAsked = this.#now();
			const said = await this.runtime.exec(name, ['cat', FIREWALL_STATUS_PATH]).catch(() => null);
			let status: FirewallStatus | null = null;
			try {
				status = said?.exitCode === 0 ? (JSON.parse(said.output) as FirewallStatus) : null;
			} catch {
				// not written yet
			}
			if (status) {
				this.containment = { state: status.state, detail: status.detail };
				this.#count(status, new Map(desired.containers.map((c) => [c.name, c.deploymentId])));
			}
		}
	}

	/**
	 * Turns the firewall's counters into what each container tried since the
	 * last look: blocked packets by kind, and a scan when it opened
	 * connections faster than any ordinary app.
	 */
	#count(status: FirewallStatus, deployments: Map<string, string>) {
		const last = this.#counters;
		const now = this.#now();
		this.#counters = { generation: status.generation, at: now, counters: status.counters ?? {} };
		if (!status.counters || !last) return;
		// rules replaced since: their counters started again from zero
		const fresh = last.generation !== status.generation;
		const minutes = Math.max((now - last.at) / 60_000, 1 / 6);
		for (const [container, now] of Object.entries(status.counters)) {
			const deploymentId = deployments.get(container);
			if (!deploymentId) continue;
			const before = fresh ? undefined : last.counters[container];
			const delta = (kind: keyof ContainerCounters) =>
				Math.max(now[kind] - (before?.[kind] ?? 0), 0);
			const add = (kind: SecurityKind, count: number) => {
				if (count <= 0) return;
				const key = `${container}:${kind}`;
				const pending = this.#security.get(key);
				if (pending) pending.count += count;
				else this.#security.set(key, { container, deploymentId, kind, count });
			};
			add('metadata', delta('metadata'));
			add('private', delta('private'));
			add('host', delta('host'));
			const connections = delta('connections');
			if (connections / minutes >= SCAN_CONNECTIONS_PER_MINUTE) add('scan', connections);
		}
	}

	/** What containers tried since the last report; reporting it clears it. */
	takeSecurity(): SecurityCount[] {
		const all = [...this.#security.values()];
		this.#security.clear();
		return all;
	}

	/**
	 * The install's tunnel connector, when this node was chosen to run it. It
	 * uses the host's network, so it reaches the control plane at the same
	 * address as a browser on this machine would.
	 */
	async #ensureTunnel(desired: DesiredState, existing: ManagedContainer[]) {
		const log = this.options.log ?? quiet;
		const tunnel = desired.tunnel ?? null;
		const spec: RunSpec | null = tunnel && {
			name: tunnel.name,
			image: tunnel.image,
			cmd: ['tunnel', '--no-autoupdate', 'run'],
			// cloudflared reads it from the environment, which keeps it out of the process list
			env: { TUNNEL_TOKEN: tunnel.token },
			network: 'host',
			aliases: [],
			restart: { name: 'always', maxRetries: 0 },
			security: {
				capabilities: [],
				pidsLimit: 256,
				memoryMb: 256,
				readOnlyRootFilesystem: true
			},
			labels: {
				[LABELS.managed]: 'true',
				[LABELS.node]: this.#node(),
				[LABELS.role]: 'tunnel',
				[LABELS.spec]: hash(tunnel)
			}
		};
		for (const container of existing.filter((c) => c.labels[LABELS.role] === 'tunnel')) {
			if (
				spec &&
				container.name === spec.name &&
				container.labels[LABELS.spec] === spec.labels[LABELS.spec]
			) {
				return;
			}
			log(`removing ${container.name}`);
			await this.runtime.remove(container.name);
		}
		if (!spec) return;
		if (!(await this.runtime.hasImage(spec.image))) await this.runtime.pull(spec.image);
		await this.runtime.run(spec);
		log(`started the tunnel connector ${spec.name}`);
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
				...(desired.ingress.tls ? [{ container: 443, host: 443 }] : []),
				// tunnel traffic: only the connector, on this host's network, can reach it
				...(desired.ingress.tunnel
					? [
							{
								container: desired.ingress.tunnel.port,
								host: desired.ingress.tunnel.port,
								hostIp: '127.0.0.1'
							}
						]
					: [])
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
					routes: 'pushed',
					// the key is only there with a tunnel, so other nodes' ingresses aren't recreated
					...(desired.ingress.tunnel ? { tunnelPort: desired.ingress.tunnel.port } : {})
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
