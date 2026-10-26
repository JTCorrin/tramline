/**
 * The slice of a container engine the agent needs. `DockerRuntime` implements
 * it against the Docker API; tests use an in-memory fake.
 */
export interface ContainerRuntime {
	version(): Promise<string>;
	ensureNetwork(name: string): Promise<void>;
	/** Containers carrying the `tramline.managed` label. */
	list(): Promise<ManagedContainer[]>;
	hasImage(image: string): Promise<boolean>;
	pull(image: string): Promise<void>;
	/** Creates and starts a container. */
	run(spec: RunSpec): Promise<void>;
	/** Force-removes a container; missing containers are ignored. */
	remove(name: string): Promise<void>;
	/** Asks a container to stop (SIGTERM), killing it after `timeoutSeconds`; missing containers are ignored. */
	stop(name: string, timeoutSeconds: number): Promise<void>;
	/** Creates a named volume with these labels unless it exists. */
	ensureVolume(name: string, labels: Record<string, string>): Promise<void>;
	/** Volumes carrying the `tramline.managed` label. */
	listVolumes(): Promise<{ name: string; labels: Record<string, string> }[]>;
	/** Removes a volume; false when a container still uses it. Missing volumes count as removed. */
	removeVolume(name: string): Promise<boolean>;
	connect(container: string, network: string): Promise<void>;
	/** A container's IPv4 address on each network it is attached to. */
	addresses(container: string): Promise<Record<string, string>>;
	exec(container: string, cmd: string[]): Promise<{ exitCode: number; output: string }>;
	/**
	 * Runs a command and streams its output. `env` is given to that process only
	 * (never stored on the container), which is how build secrets are passed.
	 * With `stdout` set, standard output is piped there instead of `onLine`.
	 */
	execStream(container: string, cmd: string[], options: ExecStreamOptions): Promise<number>;
	/** CPU architecture of the Docker host, e.g. `aarch64` or `x86_64`. */
	arch(): Promise<string>;
	/** Writes a file into a container. */
	putFile(container: string, path: string, content: Buffer, mode: number): Promise<void>;
	/** Extracts a tar archive (plain or gzip-compressed) into a directory of a container. */
	putArchive(container: string, path: string, archive: NodeJS.ReadableStream): Promise<void>;
	/** Loads an image tarball (`docker save` format). */
	loadImage(tarball: NodeJS.ReadableStream): Promise<void>;
	/** `repo@sha256:…` the registry gave a pulled image, or null (e.g. for locally built images). */
	repoDigest(reference: string): Promise<string | null>;
	/** Image ID (`sha256:…`) for a reference, or null when missing. */
	imageId(reference: string): Promise<string | null>;
	/** Images whose repository is `repository`, newest first. */
	listImages(repository: string): Promise<{ id: string; tags: string[]; created: number }[]>;
	/** Removes an image; images in use are left alone. */
	removeImage(id: string): Promise<void>;
	/** Follows a container's logs from `since` (epoch seconds) until it stops. Returns a cancel function. */
	logs(name: string, since: number, onLine: OnLogLine, onEnd: () => void): () => void;
}

export type OnLogLine = (stream: 'stdout' | 'stderr', ts: string, line: string) => void;

export interface ExecStreamOptions {
	env?: Record<string, string>;
	onLine: (stream: 'stdout' | 'stderr', line: string) => void;
	stdout?: NodeJS.WritableStream;
}

export interface ManagedContainer {
	name: string;
	labels: Record<string, string>;
	networks: string[];
	status: 'created' | 'running' | 'restarting' | 'exited' | 'dead' | 'paused' | 'removing';
	exitCode: number | null;
	restartCount: number;
	startedAt: string | null;
	/** `repo@sha256:…` of the container's image, when the registry provided one. */
	imageDigest?: string | null;
}

export interface RunSpec {
	name: string;
	image: string;
	cmd?: string[];
	env: Record<string, string>;
	labels: Record<string, string>;
	network: string;
	aliases: string[];
	restart: { name: 'no' | 'always' | 'on-failure'; maxRetries: number };
	ports?: { container: number; host: number; protocol?: 'tcp' | 'udp' }[];
	/** Namespaced kernel settings, e.g. IP forwarding inside the mesh container. */
	sysctls?: Record<string, string>;
	binds?: string[];
	/** Named Docker volumes. */
	volumes?: { name: string; target: string; readOnly?: boolean }[];
	security: SecurityOptions;
}

export interface SecurityOptions {
	/** Linux capabilities to keep (everything else is dropped), or Docker's default set. */
	capabilities: string[] | 'docker-default';
	pidsLimit: number;
	memoryMb: number | null;
	readOnlyRootFilesystem: boolean;
	/** Defaults to true. Only the rootless builder turns it off (its user namespace setup needs setuid helpers). */
	noNewPrivileges?: boolean;
	/**
	 * Run a minimal init as PID 1 (Docker's `--init`): it forwards stop signals to
	 * the app and reaps zombie processes, so `sh -c` commands shut down cleanly.
	 */
	init?: boolean;
	/** Defaults to false. Only the rootless builder needs Docker's seccomp and AppArmor profiles relaxed. */
	unconfined?: boolean;
}

export const LABELS = {
	managed: 'tramline.managed',
	/** The node whose agent owns the container; agents never touch other nodes' containers. */
	node: 'tramline.node',
	role: 'tramline.role',
	/** Built images record the service they belong to, for garbage collection. */
	service: 'tramline.service',
	spec: 'tramline.spec',
	deployment: 'tramline.deployment',
	/** Set on workloads with a volume: they get longer to shut down cleanly. */
	stateful: 'tramline.stateful',
	replica: 'tramline.replica'
} as const;
