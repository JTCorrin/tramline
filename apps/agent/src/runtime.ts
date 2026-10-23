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
	connect(container: string, network: string): Promise<void>;
	exec(container: string, cmd: string[]): Promise<{ exitCode: number; output: string }>;
	/** Follows a container's logs from `since` (epoch seconds) until it stops. Returns a cancel function. */
	logs(name: string, since: number, onLine: OnLogLine, onEnd: () => void): () => void;
}

export type OnLogLine = (stream: 'stdout' | 'stderr', ts: string, line: string) => void;

export interface ManagedContainer {
	name: string;
	labels: Record<string, string>;
	networks: string[];
	status: 'created' | 'running' | 'restarting' | 'exited' | 'dead' | 'paused' | 'removing';
	exitCode: number | null;
	restartCount: number;
	startedAt: string | null;
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
	ports?: { container: number; host: number }[];
	binds?: string[];
}

export const LABELS = {
	managed: 'tramline.managed',
	role: 'tramline.role',
	spec: 'tramline.spec',
	deployment: 'tramline.deployment',
	replica: 'tramline.replica'
} as const;
