import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
}

export interface FirewallStatus {
	state: 'active' | 'unsupported' | 'error';
	detail: string | null;
	/** `nft` or `legacy`: which iptables Docker uses. */
	backend: string | null;
	at: string;
}

const EGRESS = 'TL-EGRESS';
const INPUT = 'TL-INPUT';

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
	const tag = `-m comment --comment "tramline ${fingerprint(config)}"`;
	const lines = ['*filter', `:${EGRESS} - [0:0]`, `:${INPUT} - [0:0]`];
	const egress = (rule: string) => lines.push(`-A ${EGRESS} ${rule}`);
	const input = (rule: string) => lines.push(`-A ${INPUT} ${rule}`);

	// replies, and connections to published ports (the ingress, TCP proxies), always pass
	egress(`-m conntrack --ctstate RELATED,ESTABLISHED ${tag} -j RETURN`);
	egress('-m conntrack --ctstate DNAT -j RETURN');
	for (const ip of config.exempt.filter(valid)) egress(`-s ${ip} -j RETURN`);
	// before any opening, so no service's private ranges can include it
	for (const subnet of [...workloads, ...metadataOnly]) {
		for (const m of METADATA) egress(`-s ${subnet} -d ${m} -j DROP`);
	}
	for (const { source, destinations } of config.allow) {
		if (!valid(source)) continue;
		for (const d of destinations.filter(valid)) egress(`-s ${source} -d ${d} -j RETURN`);
	}
	for (const subnet of workloads) {
		// its own environment: Docker filters bridged traffic too
		egress(`-s ${subnet} -d ${subnet} -j RETURN`);
		// the embedded DNS server asks the host's resolvers from inside the container
		egress(`-s ${subnet} -p udp --dport 53 -j RETURN`);
		egress(`-s ${subnet} -p tcp --dport 53 -j RETURN`);
		for (const range of PRIVATE_RANGES) egress(`-s ${subnet} -d ${range} -j DROP`);
	}

	input(`-m conntrack --ctstate RELATED,ESTABLISHED ${tag} -j RETURN`);
	for (const ip of config.exempt.filter(valid)) input(`-s ${ip} -j RETURN`);
	for (const subnet of workloads) {
		input(`-s ${subnet} -p udp --dport 53 -j RETURN`);
		input(`-s ${subnet} -p tcp --dport 53 -j RETURN`);
		// the host's own ports: SSH, the agent, Tramline itself on the local node
		input(`-s ${subnet} -j DROP`);
	}
	lines.push('COMMIT', '');
	return lines.join('\n');
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
				if (await applyFirewall(config, backend, options.exec)) {
					log(
						`[firewall] containing ${config.workloads.length} networks (${backend}), ${config.allow.length} containers with private ranges open`
					);
				}
				applied = text;
				checked = Date.now();
				lastError = '';
				status({ state: 'active', backend, detail: null });
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
