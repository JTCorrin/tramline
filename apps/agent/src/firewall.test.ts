import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Converger } from './converge';
import {
	applyFirewall,
	detectBackend,
	FIREWALL_CONFIG_PATH,
	FIREWALL_STATUS_PATH,
	firewallName,
	firewallRules,
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
		expect(at('-s 172.18.0.0/16 -d 169.254.169.254/32 -j DROP')).toBeLessThan(
			at('-s 172.18.0.5 -d 192.168.1.20/32 -j RETURN')
		);
		expect(out).toContain('-s 172.17.0.0/16 -d 169.254.169.254/32 -j DROP');
		expect(out).toContain('-s 172.18.0.0/16 -d 168.63.129.16/32 -j DROP');
		// its own environment and DNS pass; every private range after that is dropped
		expect(at('-s 172.18.0.0/16 -d 172.18.0.0/16 -j RETURN')).toBeLessThan(
			at('-s 172.18.0.0/16 -d 172.16.0.0/12 -j DROP')
		);
		expect(out).toContain('-s 172.18.0.0/16 -p udp --dport 53 -j RETURN');
		for (const range of ['10.0.0.0/8', '192.168.0.0/16', '100.64.0.0/10']) {
			expect(out).toContain(`-s 172.18.0.0/16 -d ${range} -j DROP`);
		}
		// DNS passes before the metadata drops: GCP's resolver is the metadata server, Azure's is
		// its WireServer address
		expect(at('-s 172.18.0.0/16 -p udp --dport 53 -j RETURN')).toBeLessThan(
			at('-s 172.18.0.0/16 -d 169.254.169.254/32 -j DROP')
		);
		expect(at('-s 172.17.0.0/16 -p udp --dport 53 -j RETURN')).toBeLessThan(
			at('-s 172.17.0.0/16 -d 168.63.129.16/32 -j DROP')
		);
		// builds only lose the metadata endpoint (and keep DNS)
		expect(out.filter((r) => r.startsWith('-s 172.17.0.0/16') && r.endsWith('DROP'))).toHaveLength(
			2
		);

		expect(rules).toContain('-A TL-INPUT -s 172.18.0.0/16 -j DROP');
		expect(rules).not.toContain('-A TL-INPUT -s 172.17.0.0/16');
		expect(rules).toMatch(/^\*filter\n:TL-EGRESS - \[0:0\]\n:TL-INPUT - \[0:0\]\n/);
		expect(rules.trimEnd().endsWith('COMMIT')).toBe(true);
	});

	it('only ever writes plain addresses into a rule', () => {
		const rules = firewallRules({
			workloads: ['172.18.0.0/16 -j ACCEPT', '172.19.0.0/16'],
			metadataOnly: [],
			exempt: ['0.0.0.0/0 -j ACCEPT'],
			allow: [{ source: '172.19.0.4', destinations: ['10.0.0.0/8\n-A INPUT -j ACCEPT'] }]
		});
		expect(rules).not.toContain('ACCEPT');
		expect(rules).toContain('-s 172.19.0.0/16 -d 10.0.0.0/8 -j DROP');
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

	it('passes on what the firewall container says, for the report', async () => {
		const runtime = new FakeRuntime();
		runtime.pulled.add('tramline-agent:test');
		runtime.execOutput.set(
			FIREWALL_STATUS_PATH,
			JSON.stringify({ state: 'unsupported', detail: 'no DOCKER-USER', backend: null, at: '' })
		);
		const c = converger(runtime);
		await c.run(desiredState());
		await c.settled();
		expect(c.containment).toEqual({ state: 'unsupported', detail: 'no DOCKER-USER' });
	});

	it('keeps converging when the firewall fails, or never answers', async () => {
		vi.useFakeTimers();
		try {
			const runtime = new FakeRuntime();
			runtime.failPull.set('tramline-agent:test', 'manifest unknown');
			const logged: string[] = [];
			const c = new Converger(runtime, {
				nodeId: 'node_1',
				log: (m) => logged.push(m),
				firewall: { image: 'tramline-agent:test' }
			});
			await c.run(desiredState());
			expect(logged.filter((m) => m.startsWith('containment failed'))).toHaveLength(2);
			// the service still started
			expect(runtime.containers.has('tl-dep_1-0')).toBe(true);

			runtime.failPull.clear();
			runtime.exec = () => new Promise(() => {});
			await c.run({ ...desiredState(), revision: 'r2' });
			const read = c.settled();
			await vi.advanceTimersByTimeAsync(5_000);
			await read;
			expect(c.containment.state).toBe('starting');
		} finally {
			vi.useRealTimers();
		}
	});
});
