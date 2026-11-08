import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Converger } from './converge';
import {
	applyFirewall,
	detectBackend,
	FIREWALL_CONFIG_PATH,
	FIREWALL_STATUS_PATH,
	firewallName,
	firewallRules,
	readCounters,
	fingerprint,
	runFirewallDaemon,
	type FirewallConfig
} from './firewall';
import { LABELS } from './runtime';
import { desiredContainer, desiredState, FakeRuntime } from './testing';

const config: FirewallConfig = {
	workloads: ['172.18.0.0/16'],
	metadataOnly: ['172.17.0.0/16'],
	exempt: ['172.18.0.2'],
	allow: [{ source: '172.18.0.5', destinations: ['192.168.1.20/32'] }]
};

/** The EGRESS rules in order, without the chain name. */
const egress = (rules: string) =>
	rules
		.split('\n')
		.filter((l) => l.startsWith('-A TL-EGRESS '))
		.map((l) => l.slice('-A TL-EGRESS '.length));

describe('firewall rules', () => {
	it('drops the metadata endpoint, private ranges and host ports for service containers', () => {
		const rules = firewallRules(config);
		const out = egress(rules);
		const at = (rule: string) => out.findIndex((r) => r.includes(rule));

		// replies and published ports first, then Tramline's own containers
		expect(out[0]).toMatch(/^-m conntrack --ctstate RELATED,ESTABLISHED .*-j RETURN$/);
		expect(out[1]).toBe('-m conntrack --ctstate DNAT -j RETURN');
		expect(out[2]).toBe('-s 172.18.0.2 -j RETURN');
		// metadata is dropped before any opening, for builds too
		expect(at('-s 172.18.0.0/16 -d 169.254.169.254/32 -j TL-METADATA')).toBeLessThan(
			at('-s 172.18.0.5 -d 192.168.1.20/32 -j RETURN')
		);
		expect(out).toContain('-s 172.17.0.0/16 -d 169.254.169.254/32 -j TL-METADATA');
		expect(out).toContain('-s 172.18.0.0/16 -d 168.63.129.16/32 -j TL-METADATA');
		// its own environment and DNS pass; every private range after that is dropped
		expect(at('-s 172.18.0.0/16 -d 172.18.0.0/16 -j RETURN')).toBeLessThan(
			at('-s 172.18.0.0/16 -d 172.16.0.0/12 -j TL-PRIVATE')
		);
		expect(out).toContain('-s 172.18.0.0/16 -p udp --dport 53 -j RETURN');
		for (const range of ['10.0.0.0/8', '192.168.0.0/16', '100.64.0.0/10']) {
			expect(out).toContain(`-s 172.18.0.0/16 -d ${range} -j TL-PRIVATE`);
		}
		// DNS passes before the metadata drops: GCP's resolver is the metadata server, Azure's is
		// its WireServer address
		expect(at('-s 172.18.0.0/16 -p udp --dport 53 -j RETURN')).toBeLessThan(
			at('-s 172.18.0.0/16 -d 169.254.169.254/32 -j TL-METADATA')
		);
		expect(at('-s 172.17.0.0/16 -p udp --dport 53 -j RETURN')).toBeLessThan(
			at('-s 172.17.0.0/16 -d 168.63.129.16/32 -j TL-METADATA')
		);
		// builds only lose the metadata endpoint (and keep DNS)
		expect(
			out.filter((r) => r.startsWith('-s 172.17.0.0/16') && r.includes('-j TL-'))
		).toHaveLength(2);

		expect(rules).toContain('-A TL-INPUT -s 172.18.0.0/16 -j TL-HOST');
		expect(rules).not.toContain('-A TL-INPUT -s 172.17.0.0/16');
		expect(rules).toMatch(/^\*filter\n:TL-EGRESS - \[0:0\]\n:TL-INPUT - \[0:0\]\n:TL-METADATA/);
		expect(rules.trimEnd().endsWith('COMMIT')).toBe(true);
	});

	it('counts what each container tried, then drops it', () => {
		const rules = firewallRules({
			...config,
			containers: [
				{ name: 'tl-dep_1-0', ip: '172.18.0.5' },
				{ name: 'bad name"; -j ACCEPT', ip: '172.18.0.6' }
			]
		});
		for (const chain of ['TL-METADATA', 'TL-PRIVATE', 'TL-HOST']) {
			const own = rules.split('\n').filter((l) => l.startsWith(`-A ${chain} `));
			expect(own).toEqual([
				`-A ${chain} -s 172.18.0.5 -m comment --comment "c:tl-dep_1-0" -j DROP`,
				`-A ${chain} -j DROP`
			]);
		}
		// new connections are counted (no target), after DNS and before anything is dropped
		const out = egress(rules);
		const counter = out.indexOf(
			'-s 172.18.0.5 -m conntrack --ctstate NEW -m comment --comment "n:tl-dep_1-0"'
		);
		expect(counter).toBeGreaterThan(out.indexOf('-s 172.18.0.0/16 -p tcp --dport 53 -j RETURN'));
		expect(counter).toBeLessThan(out.findIndex((r) => r.includes('-j TL-METADATA')));
		expect(rules).not.toContain('ACCEPT');
	});

	it('reads the counters back by container', async () => {
		const listed: Record<string, string> = {
			'TL-METADATA':
				'-N TL-METADATA\n-A TL-METADATA -s 172.18.0.5/32 -m comment --comment "c:tl-dep_1-0" -c 3 180 -j DROP\n-A TL-METADATA -c 9 540 -j DROP',
			'TL-PRIVATE':
				'-A TL-PRIVATE -s 172.18.0.5/32 -m comment --comment c:tl-dep_1-0 -c 7 420 -j DROP',
			'TL-HOST': '-A TL-HOST -s 172.18.0.5/32 -m comment --comment "c:tl-dep_1-0" -c 0 0 -j DROP',
			'TL-EGRESS':
				'-A TL-EGRESS -s 172.18.0.5/32 -m conntrack --ctstate NEW -m comment --comment "n:tl-dep_1-0" -c 42 2520'
		};
		const exec = async (_cmd: string, args: string[]) => listed[args[1]!] ?? '';
		expect(await readCounters('nft', exec)).toEqual({
			'tl-dep_1-0': { metadata: 3, private: 7, host: 0, connections: 42 }
		});
	});

	it('only ever writes plain addresses into a rule', () => {
		const rules = firewallRules({
			workloads: ['172.18.0.0/16 -j ACCEPT', '172.19.0.0/16'],
			metadataOnly: [],
			exempt: ['0.0.0.0/0 -j ACCEPT'],
			allow: [{ source: '172.19.0.4', destinations: ['10.0.0.0/8\n-A INPUT -j ACCEPT'] }]
		});
		expect(rules).not.toContain('ACCEPT');
		expect(rules).toContain('-s 172.19.0.0/16 -d 10.0.0.0/8 -j TL-PRIVATE');
	});
});

/** A fake iptables: chains as rule lists, and a log of what ran. */
function fakeIptables(backend: 'nft' | 'legacy' | null = 'nft') {
	const chains = new Map<string, string[]>([
		['DOCKER-USER', []],
		['INPUT', []]
	]);
	const ran: string[] = [];
	const exec = async (cmd: string, args: string[], input?: string) => {
		ran.push(`${cmd} ${args.join(' ')}`);
		if (backend === null || !cmd.startsWith(`iptables-${backend}`)) throw new Error('not found');
		if (cmd.endsWith('-restore')) {
			for (const line of input!.split('\n')) {
				const declared = line.match(/^:(\S+)/);
				if (declared) chains.set(declared[1]!, []);
				const rule = line.match(/^-A (\S+) (.*)$/);
				if (rule) chains.get(rule[1]!)!.push(rule[2]!);
			}
			return '';
		}
		const [flag, chain, ...rest] = args;
		const rules = chains.get(chain!);
		if (!rules) throw new Error(`No chain ${chain}`);
		if (flag === '-S') return rules.map((r) => `-A ${chain} ${r}`).join('\n');
		if (flag === '-C') {
			if (!rules.includes(rest.join(' '))) throw new Error('Bad rule');
			return '';
		}
		if (flag === '-I') rules.splice(0, 0, rest.slice(1).join(' '));
		return '';
	};
	return { chains, ran, exec };
}

describe('applying the rules', () => {
	it('uses the iptables Docker uses', async () => {
		expect(await detectBackend(fakeIptables('legacy').exec)).toBe('legacy');
		expect(await detectBackend(fakeIptables(null).exec)).toBeNull();
	});

	it('puts its chains first, and only touches them again when they change or go', async () => {
		const ipt = fakeIptables();
		expect(await applyFirewall(config, 'nft', ipt.exec)).toBe(true);
		expect(ipt.chains.get('DOCKER-USER')![0]).toBe('-j TL-EGRESS');
		expect(ipt.chains.get('INPUT')![0]).toBe('-j TL-INPUT');
		expect(ipt.chains.get('TL-EGRESS')![0]).toContain(`tramline ${fingerprint(config)}`);

		expect(await applyFirewall(config, 'nft', ipt.exec)).toBe(false);
		// a firewall reload took the jump away
		ipt.chains.set('INPUT', []);
		expect(await applyFirewall(config, 'nft', ipt.exec)).toBe(true);
		expect(ipt.chains.get('INPUT')).toEqual(['-j TL-INPUT']);
		expect(ipt.chains.get('DOCKER-USER')).toEqual(['-j TL-EGRESS']);

		const changed = { ...config, workloads: [...config.workloads, '172.19.0.0/16'] };
		expect(await applyFirewall(changed, 'nft', ipt.exec)).toBe(true);
		expect(ipt.chains.get('TL-EGRESS')!.some((r) => r.startsWith('-s 172.19.0.0/16'))).toBe(true);
	});

	it('runs as a daemon, and says how it went', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'tramline-firewall-'));
		const file = path.join(dir, 'firewall.json');
		const statusPath = path.join(dir, 'status.json');
		writeFileSync(file, JSON.stringify(config));
		const ipt = fakeIptables();
		const abort = new AbortController();
		const daemon = runFirewallDaemon(file, {
			exec: ipt.exec,
			intervalMs: 5,
			statusPath,
			signal: abort.signal,
			log: () => {}
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		abort.abort();
		await daemon;
		expect(JSON.parse(readFileSync(statusPath, 'utf8'))).toMatchObject({
			state: 'active',
			backend: 'nft'
		});
		expect(ipt.chains.get('DOCKER-USER')).toEqual(['-j TL-EGRESS']);

		// without Docker's chain there is nothing to hook into
		const none = new AbortController();
		const unsupported = runFirewallDaemon(file, {
			exec: fakeIptables(null).exec,
			intervalMs: 5,
			statusPath,
			signal: none.signal,
			log: () => {}
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		none.abort();
		await unsupported;
		expect(JSON.parse(readFileSync(statusPath, 'utf8'))).toMatchObject({ state: 'unsupported' });
	});
});

describe('the firewall container', () => {
	const converger = (runtime: FakeRuntime, image: string | null = 'tramline-agent:test') =>
		new Converger(runtime, {
			nodeId: 'node_1',
			log: () => {},
			...(image ? { firewall: { image } } : {})
		});

	it('runs on the host network with NET_ADMIN, and writes which networks to contain', async () => {
		const runtime = new FakeRuntime();
		runtime.pulled.add('tramline-agent:test');
		const nas = desiredContainer({
			name: 'tl-dep_2-0',
			deploymentId: 'dep_2',
			privateNetworks: ['192.168.1.20/32']
		});
		await converger(runtime).run(desiredState([desiredContainer(), nas]));

		const fw = runtime.containers.get(firewallName('node_1'))!;
		expect(fw.spec).toMatchObject({
			cmd: ['firewall'],
			network: 'host',
			security: { capabilities: ['NET_ADMIN', 'NET_RAW'] },
			labels: { [LABELS.role]: 'firewall' }
		});
		const written = JSON.parse(
			runtime.files.get(`${firewallName('node_1')}:${FIREWALL_CONFIG_PATH}`)!.toString()
		) as FirewallConfig;
		expect(written.workloads).toEqual(['172.18.0.0/16']);
		expect(written.metadataOnly).toEqual(['172.17.0.0/16']);
		// the ingress runs on the environment network, and isn't contained
		expect(written.exempt).toHaveLength(1);
		expect(written.allow).toEqual([{ source: '172.30.0.2', destinations: ['192.168.1.20/32'] }]);
	});

	it('says so when containment is off', async () => {
		const runtime = new FakeRuntime();
		const c = converger(runtime, null);
		await c.run(desiredState());
		expect(c.containment.state).toBe('off');
		expect(runtime.containers.has(firewallName('node_1'))).toBe(false);
	});

	it('reports what each container tried since the last look, and scans', async () => {
		const runtime = new FakeRuntime();
		runtime.pulled.add('tramline-agent:test');
		let clock = 1_000_000;
		const c = new Converger(runtime, {
			nodeId: 'node_1',
			log: () => {},
			now: () => clock,
			firewall: { image: 'tramline-agent:test' }
		});
		const said = (generation: string, metadata: number, connections: number) =>
			runtime.execOutput.set(
				FIREWALL_STATUS_PATH,
				JSON.stringify({
					state: 'active',
					detail: null,
					backend: 'nft',
					generation,
					counters: { 'tl-dep_1-0': { metadata, private: 0, host: 2, connections } },
					at: new Date(clock).toISOString()
				})
			);
		const desired = desiredState();

		said('g1', 5, 10);
		await c.run(desired);
		// the first look is where counting starts
		expect(c.takeSecurity()).toEqual([]);
		expect(c.containment.state).toBe('active');

		clock += 60_000;
		said('g1', 8, 20);
		await c.run({ ...desired, revision: 'r2' });
		expect(c.takeSecurity()).toEqual([
			{ container: 'tl-dep_1-0', deploymentId: 'dep_1', kind: 'metadata', count: 3 }
		]);
		expect(c.takeSecurity()).toEqual([]);

		// new rules started the counters again; 900 connections in a minute is a scan
		clock += 60_000;
		said('g2', 1, 900);
		await c.run({ ...desired, revision: 'r3' });
		expect(c.takeSecurity()).toEqual([
			{ container: 'tl-dep_1-0', deploymentId: 'dep_1', kind: 'metadata', count: 1 },
			{ container: 'tl-dep_1-0', deploymentId: 'dep_1', kind: 'host', count: 2 },
			{ container: 'tl-dep_1-0', deploymentId: 'dep_1', kind: 'scan', count: 900 }
		]);
	});
});
