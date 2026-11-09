import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { run as defaultRun, type Run } from './mesh-daemon';

/**
 * Containment: what a service container can reach. A hostile workload's
 * first moves are the cloud metadata endpoint, the node's LAN, the mesh,
 * other environments and the host's own ports (the agent, Tramline itself on
 * the local node, SSH). The firewall container (`agent.mjs firewall`, on the
 * host's network with NET_ADMIN and nothing else) keeps rules in Docker's
 * `DOCKER-USER` chain and the host's INPUT chain that drop all of that for
 * traffic from Tramline's environment networks. A container still reaches
 * its own environment, the internet, DNS and published ports.
 *
 * The rules live in Tramline's own chains, replaced whole and atomically
 * with `iptables-restore`, and are put back if something (a reboot, a
 * firewall reload) removes them.
 */

/** One per node; it runs on the host's network. */
export const firewallName = (nodeId: string) => `tramline-firewall-${nodeId}`;

export const FIREWALL_CONFIG_PATH = '/etc/tramline/firewall.json';
export const FIREWALL_STATUS_PATH = '/run/tramline/firewall-status.json';

/** Cloud metadata services: GCP, AWS and Azure (169.254.169.254) and Azure's WireServer. */
export const METADATA = ['169.254.169.254/32', '168.63.129.16/32'];

/** Everything that isn't the internet: LANs, link-local, CGNAT (Tailscale), the mesh, Docker's own networks. */
export const PRIVATE_RANGES = [
	'10.0.0.0/8',
	'172.16.0.0/12',
	'192.168.0.0/16',
	'100.64.0.0/10',
	'169.254.0.0/16',
	'0.0.0.0/8',
	'198.18.0.0/15'
];

export interface FirewallConfig {
	/** Environment networks' subnets: fully contained. */
	workloads: string[];
	/** Other networks whose containers run user code (builds): metadata blocked, nothing else. */
	metadataOnly: string[];
	/** Tramline's own containers on those networks (the ingress, the mesh), which are not contained. */
	exempt: string[];
	/** Private ranges a service may reach, by its containers' addresses. */
	allow: { source: string; destinations: string[] }[];
	/** Service containers, by address, whose blocked attempts and new connections are counted. */
	containers?: { name: string; ip: string }[];
}

/** What a container tried, as the firewall's counters say: packets dropped, and new connections. */
export interface ContainerCounters {
	metadata: number;
	private: number;
	host: number;
	connections: number;
}

export interface FirewallStatus {
	state: 'active' | 'unsupported' | 'error';
	detail: string | null;
	/** `nft` or `legacy`: which iptables Docker uses. */
	backend: string | null;
	/** This daemon's run: counters start again from zero when it changes (a restart). */
	generation?: string;
	/** Per container, since this daemon started, across rule replacements. */
	counters?: Record<string, ContainerCounters>;
	at: string;
}

const EGRESS = 'TL-EGRESS';
const INPUT = 'TL-INPUT';
/** Where each kind of blocked packet goes to be counted, by container, and dropped. */
const BLOCKS = { metadata: 'TL-METADATA', private: 'TL-PRIVATE', host: 'TL-HOST' } as const;
/** Docker container names; a name ends up inside a rule's comment. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;
/** Only plain IPv4 addresses and blocks reach the rules: nothing in a config can add an option. */
const valid = (cidr: string) => IPV4.test(cidr);

/** A short fingerprint of the rules, kept as a comment so a check can tell they're current. */
export const fingerprint = (config: FirewallConfig) =>
	createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 12);

/**
 * The `iptables-restore --noflush` input for Tramline's two chains. Declaring
 * a chain empties it, so the whole set is replaced in one step and other
 * chains are left alone.
 */
export function firewallRules(config: FirewallConfig) {
	const workloads = config.workloads.filter(valid);
	const metadataOnly = config.metadataOnly.filter(valid);
	const counted = (config.containers ?? []).filter(
		(c) => valid(c.ip) && !c.ip.includes('/') && NAME.test(c.name)
	);
	const tag = `-m comment --comment "tramline ${fingerprint(config)}"`;
	const chains = [EGRESS, INPUT, ...Object.values(BLOCKS)];
	const lines = ['*filter', ...chains.map((c) => `:${c} - [0:0]`)];
	const egress = (rule: string) => lines.push(`-A ${EGRESS} ${rule}`);
	const input = (rule: string) => lines.push(`-A ${INPUT} ${rule}`);

	// replies, and connections to published ports (the ingress, TCP proxies), always pass
	egress(`-m conntrack --ctstate RELATED,ESTABLISHED ${tag} -j RETURN`);
	egress('-m conntrack --ctstate DNAT -j RETURN');
	for (const ip of config.exempt.filter(valid)) egress(`-s ${ip} -j RETURN`);
	for (const subnet of [...workloads, ...metadataOnly]) {
		// DNS first: on GCP the metadata server is the resolver, and on Azure its WireServer
		// address is; Docker's embedded DNS asks them from inside the container. Port 53 hands
		// out no credentials (the metadata service serves those over HTTP)
		egress(`-s ${subnet} -p udp --dport 53 -j RETURN`);
		egress(`-s ${subnet} -p tcp --dport 53 -j RETURN`);
	}
	// counts each container's new connections (no target: the packet carries on), for scans
	for (const c of counted) {
		egress(`-s ${c.ip} -m conntrack --ctstate NEW -m comment --comment "n:${c.name}"`);
	}
	// before any opening, so no service's private ranges can include it
	for (const subnet of [...workloads, ...metadataOnly]) {
		for (const m of METADATA) egress(`-s ${subnet} -d ${m} -j ${BLOCKS.metadata}`);
	}
	for (const { source, destinations } of config.allow) {
		if (!valid(source)) continue;
		for (const d of destinations.filter(valid)) egress(`-s ${source} -d ${d} -j RETURN`);
	}
	for (const subnet of workloads) {
		// its own environment: Docker filters bridged traffic too
		egress(`-s ${subnet} -d ${subnet} -j RETURN`);
		for (const range of PRIVATE_RANGES) egress(`-s ${subnet} -d ${range} -j ${BLOCKS.private}`);
	}

	input(`-m conntrack --ctstate RELATED,ESTABLISHED ${tag} -j RETURN`);
	for (const ip of config.exempt.filter(valid)) input(`-s ${ip} -j RETURN`);
	for (const subnet of workloads) {
		input(`-s ${subnet} -p udp --dport 53 -j RETURN`);
		input(`-s ${subnet} -p tcp --dport 53 -j RETURN`);
		// the host's own ports: SSH, the agent, Docker's API, Tramline itself on the local node
		input(`-s ${subnet} -j ${BLOCKS.host}`);
	}

	// each block chain counts by container, then drops whatever it's given
	for (const chain of Object.values(BLOCKS)) {
		for (const c of counted) {
			lines.push(`-A ${chain} -s ${c.ip} -m comment --comment "c:${c.name}" -j DROP`);
		}
		lines.push(`-A ${chain} -j DROP`);
	}
	lines.push('COMMIT', '');
	return lines.join('\n');
}

/**
 * Reads the counters of Tramline's chains (`iptables -S -v` prints `-c
 * packets bytes` on each rule) into per-container counts.
 */
export async function readCounters(backend: string, exec: Run = defaultRun) {
	const counters: Record<string, ContainerCounters> = {};
	const of = (name: string) =>
		(counters[name] ??= { metadata: 0, private: 0, host: 0, connections: 0 });
	const read = async (chain: string, each: (name: string, packets: number) => void) => {
		const out = await exec(`iptables-${backend}`, ['-S', chain, '-v']).catch(() => '');
		for (const line of out.split('\n')) {
			const name = line.match(/--comment "?[cn]:([A-Za-z0-9_.-]+)"?/)?.[1];
			const packets = line.match(/ -c (\d+) \d+/)?.[1];
			if (name && packets) each(name, Number(packets));
		}
	};
	for (const [kind, chain] of Object.entries(BLOCKS) as [keyof typeof BLOCKS, string][]) {
		await read(chain, (name, packets) => (of(name)[kind] += packets));
	}
	await read(EGRESS, (name, packets) => (of(name).connections += packets));
	return counters;
}

/** Which iptables Docker set up its chains with; the rules must go in the same one. */
export async function detectBackend(exec: Run = defaultRun) {
	for (const backend of ['nft', 'legacy'] as const) {
		try {
			await exec(`iptables-${backend}`, ['-S', 'DOCKER-USER']);
			return backend;
		} catch {
			// not this one
		}
	}
	return null;
}

/** Puts Tramline's chains in place if they're missing or stale. Returns whether it changed anything. */
export async function applyFirewall(
	config: FirewallConfig,
	backend: string,
	exec: Run = defaultRun
) {
	const iptables = `iptables-${backend}`;
	const current = await exec(iptables, ['-S', EGRESS]).catch(() => '');
	const jumped = async (chain: string, target: string) =>
		exec(iptables, ['-C', chain, '-j', target]).then(
			() => true,
			() => false
		);
	const fresh =
		current.includes(`tramline ${fingerprint(config)}`) &&
		(await jumped('DOCKER-USER', EGRESS)) &&
		(await jumped('INPUT', INPUT));
	if (fresh) return false;
	await exec(`${iptables}-restore`, ['--noflush'], firewallRules(config));
	// first in line, ahead of anything that would accept the traffic
	if (!(await jumped('DOCKER-USER', EGRESS))) {
		await exec(iptables, ['-I', 'DOCKER-USER', '1', '-j', EGRESS]);
	}
	if (!(await jumped('INPUT', INPUT))) await exec(iptables, ['-I', 'INPUT', '1', '-j', INPUT]);
	return true;
}

const add = (a: ContainerCounters | undefined, b: ContainerCounters): ContainerCounters => ({
	metadata: (a?.metadata ?? 0) + b.metadata,
	private: (a?.private ?? 0) + b.private,
	host: (a?.host ?? 0) + b.host,
	connections: (a?.connections ?? 0) + b.connections
});

/** What was carried over plus what the rules count now, per container. */
function total(carried: Record<string, ContainerCounters>, now: Record<string, ContainerCounters>) {
	const all = { ...carried };
	for (const [name, counts] of Object.entries(now)) all[name] = add(all[name], counts);
	return all;
}

export interface FirewallDaemonOptions {
	intervalMs?: number;
	exec?: Run;
	log?: (message: string) => void;
	signal?: AbortSignal;
	statusPath?: string;
}

/** Applies the config file the agent writes, and checks the rules are still there, until `signal` aborts. */
export async function runFirewallDaemon(file: string, options: FirewallDaemonOptions = {}) {
	const log = options.log ?? console.log;
	const statusPath = options.statusPath ?? FIREWALL_STATUS_PATH;
	const status = (s: Omit<FirewallStatus, 'at'>) => {
		try {
			mkdirSync(path.dirname(statusPath), { recursive: true });
			writeFileSync(statusPath, JSON.stringify({ ...s, at: new Date().toISOString() }));
		} catch {
			// the agent asks again
		}
	};
	let backend: string | null = null;
	let lastError = '';
	let applied = '';
	let checked = 0;
	let counted = 0;
	// counters since this daemon started, across rule replacements; a new daemon starts again
	const carried: Record<string, ContainerCounters> = {};
	const instance = randomBytes(6).toString('hex');
	const interval = options.intervalMs ?? 1_000;
	log('[firewall] waiting for config');
	while (!options.signal?.aborted) {
		try {
			backend ??= await detectBackend(options.exec);
			const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
			if (!backend) {
				status({
					state: 'unsupported',
					backend: null,
					detail:
						"Docker's DOCKER-USER chain isn't there (Docker's nftables firewall backend, or no iptables), so containers aren't contained"
				});
			} else if (text && (text !== applied || Date.now() - checked > 15 * interval)) {
				// a new config at once; otherwise a check now and then that nothing removed the rules
				const config = JSON.parse(text) as FirewallConfig;
				// replacing the rules zeroes their counters: keep what they held
				const before = await readCounters(backend, options.exec);
				if (await applyFirewall(config, backend, options.exec)) {
					const kept = new Set((config.containers ?? []).map((c) => c.name));
					for (const [name, counts] of Object.entries(before)) {
						if (kept.has(name)) carried[name] = add(carried[name], counts);
					}
					for (const name of Object.keys(carried)) if (!kept.has(name)) delete carried[name];
					log(
						`[firewall] containing ${config.workloads.length} networks (${backend}), ${config.allow.length} containers with private ranges open`
					);
				}
				applied = text;
				checked = Date.now();
				lastError = '';
				counted = 0;
			}
			// what each container tried, every ten checks or so
			if (backend && applied && Date.now() - counted > 10 * interval) {
				counted = Date.now();
				status({
					state: 'active',
					backend,
					detail: null,
					generation: instance,
					counters: total(carried, await readCounters(backend, options.exec))
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message !== lastError) log(`[firewall] ${message}`);
			lastError = message;
			applied = '';
			status({ state: 'error', backend, detail: message });
		}
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
}
