import type { DesiredBuild, DesiredScan, ScanMode } from '@tramline/contracts';
import { describe as group, expect, it } from 'vitest';
import { Builder, cacheVolume, jobContainerName } from './builder';
import { TRIVY } from './pins';
import { describe, scanError, summarise, type TrivyReport } from './scanner';
import { FakeRuntime, fakeTools, stateDirWithTools } from './testing';

const NOW = new Date('2026-10-23T12:00:00Z');

const vuln = (id: string, severity: string, fixed?: string, pkg = 'openssl') => ({
	VulnerabilityID: id,
	PkgName: pkg,
	InstalledVersion: '3.0.0',
	FixedVersion: fixed,
	Severity: severity,
	Title: `${id} title`
});

const REPORT: TrivyReport = {
	Results: [
		{
			Target: 'debian 12',
			Vulnerabilities: [
				vuln('CVE-1', 'CRITICAL', '3.0.1, 3.1.0'),
				vuln('CVE-2', 'CRITICAL'),
				vuln('CVE-3', 'HIGH', '3.0.2'),
				vuln('CVE-4', 'LOW'),
				vuln('CVE-5', 'NEGLIGIBLE')
			]
		},
		// the same vulnerability in the same package, reported for a second target
		{ Target: 'app', Vulnerabilities: [vuln('CVE-1', 'CRITICAL', '3.0.1')] },
		{ Target: 'node_modules' }
	]
};

group('summarise', () => {
	it('counts each vulnerability once and puts the most severe, fixable ones first', () => {
		const result = summarise(REPORT, 'warn', NOW);
		expect(result).toMatchObject({
			scanner: `Trivy ${TRIVY.version}`,
			outcome: 'warned',
			counts: { critical: 2, high: 1, medium: 0, low: 1, unknown: 1 },
			fixableCritical: 1,
			error: null,
			scannedAt: NOW.toISOString()
		});
		expect(result.findings.map((f) => f.id)).toEqual(['CVE-1', 'CVE-2', 'CVE-3', 'CVE-4', 'CVE-5']);
		expect(result.findings[0]).toEqual({
			id: 'CVE-1',
			severity: 'critical',
			package: 'openssl',
			installed: '3.0.0',
			fixed: '3.0.1',
			title: 'CVE-1 title'
		});
		expect(describe(result)).toBe('Found 2 critical (1 fixable), 1 high, 1 low, 1 unknown');
	});

	it('blocks only fixable critical findings, and only in block mode', () => {
		expect(summarise(REPORT, 'block', NOW).outcome).toBe('blocked');
		const unfixable: TrivyReport = { Results: [{ Vulnerabilities: [vuln('CVE-2', 'CRITICAL')] }] };
		expect(summarise(unfixable, 'block', NOW).outcome).toBe('warned');
		const minor: TrivyReport = { Results: [{ Vulnerabilities: [vuln('CVE-9', 'MEDIUM', '1')] }] };
		expect(summarise(minor, 'block', NOW).outcome).toBe('clean');
		expect(summarise({}, 'warn', NOW)).toMatchObject({ outcome: 'clean', findings: [] });
		expect(describe(summarise({}, 'warn', NOW))).toBe('No known vulnerabilities');
	});

	it('keeps at most 50 findings but counts them all', () => {
		const many: TrivyReport = {
			Results: [
				{
					Vulnerabilities: Array.from({ length: 70 }, (_, i) =>
						vuln(`CVE-${i}`, 'HIGH', undefined, `pkg${i}`)
					)
				}
			]
		};
		const result = summarise(many, 'warn', NOW);
		expect(result.findings).toHaveLength(50);
		expect(result.counts.high).toBe(70);
	});

	it('describes a failed scan', () => {
		expect(describe(scanError('no network', NOW))).toBe('Scan failed: no network');
	});
});

const COMMIT = 'a'.repeat(40);

function job(scan: ScanMode): DesiredBuild {
	return {
		deploymentId: 'dep_1',
		serviceId: 'svc_1',
		organizationId: 'org_1',
		repo: 'https://github.com/acme/api',
		ref: 'main',
		commit: null,
		token: null,
		rootDirectory: '/',
		builder: 'dockerfile',
		dockerfilePath: null,
		buildCommand: null,
		startCommand: null,
		image: 'tramline/svc_1:dep_1',
		secrets: {},
		scan
	};
}

/** Trivy's versioned binary on the cache volume. */
const isTrivy = (path: string) => (path.split('/').at(-1) ?? '').startsWith('trivy-');

/** A builder whose fake Trivy reports `report`, or exits with `trivyExit`. */
function setup(options: { report?: TrivyReport | string; trivyExit?: number } = {}) {
	const runtime = new FakeRuntime();
	let loaded = false;
	runtime.loadImage = async (tarball) => {
		for await (const _ of tarball) {
			// drain
		}
		loaded = true;
		runtime.images.set('tramline/svc_1:dep_1', { id: 'sha256:built000000000000', created: 1 });
	};
	runtime.onExec = (cmd, { onLine, stdout }) => {
		const program = cmd[0]!;
		if (program === 'sh') {
			onLine('stdout', COMMIT);
			return 0;
		}
		if (isTrivy(program) && cmd[1] === '--version') {
			onLine('stdout', `Version: ${TRIVY.version}`);
			return 0;
		}
		if (isTrivy(program)) {
			onLine('stderr', 'Downloading vulnerability DB');
			return options.trivyExit ?? 0;
		}
		if (program === 'cat' && cmd[1]!.endsWith('scan.json')) {
			const report = options.report ?? REPORT;
			stdout!.write(typeof report === 'string' ? report : JSON.stringify(report));
			return 0;
		}
		if (program === 'cat') {
			stdout!.write('image tarball');
			return 0;
		}
		return 0;
	};
	const lines: string[] = [];
	const builder = new Builder(runtime, {
		stateDir: stateDirWithTools(),
		tools: fakeTools,
		nodeId: () => 'node_1',
		onLine: (_, line) => lines.push(line),
		readyPollMs: 1
	});
	return { runtime, builder, lines, wasLoaded: () => loaded };
}

const trivyRun = (runtime: FakeRuntime) =>
	runtime.execs.find(
		(e) => isTrivy(e.cmd[0]!) && e.cmd[1] === 'image' && !e.cmd.includes('--download-db-only')
	);

group('Builder scanning', () => {
	it('builds to a file, scans it and loads it when allowed', async () => {
		const { runtime, builder, lines, wasLoaded } = setup();
		const result = await builder.build(job('warn'));
		expect(result).toMatchObject({ state: 'succeeded', image: 'sha256:built000000000000' });
		expect(result.scan).toMatchObject({ outcome: 'warned', fixableCritical: 1 });
		expect(wasLoaded()).toBe(true);

		const buildctl = runtime.execs.find((e) => e.cmd[0] === 'buildctl' && e.cmd[1] === 'build')!;
		expect(buildctl.cmd).toContain(
			'type=docker,name=tramline/svc_1:dep_1,dest=/home/user/work/image.tar'
		);
		const trivy = trivyRun(runtime)!;
		expect(trivy.cmd).toEqual(
			expect.arrayContaining([
				'--scanners',
				'vuln',
				'--skip-version-check',
				'--input',
				'/home/user/work/image.tar'
			])
		);
		expect(trivy.cmd.join(' ')).toContain(
			'--cache-dir /home/user/.local/share/buildkit/trivy-cache'
		);
		expect(trivy.env).toMatchObject({ TRIVY_NO_PROGRESS: 'true' });
		expect(lines).toEqual(
			expect.arrayContaining([
				`Scanning for vulnerabilities with Trivy ${TRIVY.version}`,
				'Downloading vulnerability DB',
				'Found 2 critical (1 fixable), 1 high, 1 low, 1 unknown',
				'  CVE-1 in openssl 3.0.0 (fixed in 3.0.1)',
				'  CVE-2 in openssl 3.0.0'
			])
		);
	});

	it('never loads an image that block mode refuses', async () => {
		const { builder, wasLoaded } = setup();
		const result = await builder.build(job('block'));
		expect(result).toMatchObject({
			state: 'failed',
			image: null,
			commit: COMMIT,
			error: 'Blocked: 1 critical vulnerability with a fix available'
		});
		expect(result.scan?.outcome).toBe('blocked');
		expect(wasLoaded()).toBe(false);
	});

	it('deploys anyway when a scan fails in warn mode, and refuses in block mode', async () => {
		const warn = setup({ trivyExit: 1 });
		const warned = await warn.builder.build(job('warn'));
		expect(warned.state).toBe('succeeded');
		expect(warned.scan).toMatchObject({
			outcome: 'error',
			error: 'Trivy exited with code 1; see the build log'
		});

		const block = setup({ report: 'not json' });
		const blocked = await block.builder.build(job('block'));
		expect(blocked).toMatchObject({
			state: 'failed',
			error: 'Blocked: the image could not be scanned (Trivy wrote an unreadable report)'
		});
		expect(block.wasLoaded()).toBe(false);
	});

	it('streams straight into Docker without scanning when scanning is off', async () => {
		const { runtime, builder, wasLoaded } = setup();
		const result = await builder.build(job('off'));
		expect(result).toMatchObject({ state: 'succeeded', scan: null });
		expect(trivyRun(runtime)).toBeUndefined();
		expect(wasLoaded()).toBe(true);
	});

	it('keeps the vulnerability database on the cache volume, and logs a failed update', async () => {
		const { runtime, builder } = setup();
		await builder.build(job('warn'));
		expect(
			runtime.execs.find((e) => e.cmd.includes('--download-db-only'))?.cmd.join(' ')
		).toContain('--cache-dir /home/user/.local/share/buildkit/trivy-cache');

		const offline = setup();
		const logged: string[] = [];
		const quiet = new Builder(offline.runtime, {
			stateDir: stateDirWithTools(),
			tools: fakeTools,
			nodeId: () => 'node_1',
			onLine: () => {},
			log: (message) => logged.push(message),
			readyPollMs: 1
		});
		const scan = offline.runtime.onExec;
		offline.runtime.onExec = (cmd, options) => {
			if (cmd.includes('--download-db-only')) {
				options.onLine('stderr', 'connection refused');
				return 1;
			}
			return scan(cmd, options);
		};
		await quiet.build(job('warn'));
		expect(logged).toEqual([
			"Could not download Trivy's vulnerability database: connection refused"
		]);
	});

	it('installs Trivy on the cache volume only when this version is missing', async () => {
		const { runtime, builder } = setup();
		const trivy = `${jobContainerName('dep_1')}:/home/user/.local/share/buildkit/tools/trivy-${TRIVY.version}`;
		// the fake reports every `test -x` as present
		await builder.build(job('warn'));
		expect(runtime.files.has(trivy)).toBe(false);

		const fresh = setup();
		const base = fresh.runtime.onExec;
		fresh.runtime.onExec = (cmd, options) =>
			cmd[0] === 'test' && cmd[1] === '-x' ? 1 : base(cmd, options);
		await fresh.builder.build(job('warn'));
		expect(fresh.runtime.files.get(trivy)?.toString()).toBe('binary');
	});

	it('runs registry scans on a shared scan cache, never an organization’s', async () => {
		const { runtime, builder } = setup({ report: {} });
		runtime.digests.set('traefik/whoami', 'traefik/whoami@sha256:abc');
		const started: { volumes?: { name: string }[] }[] = [];
		const run = runtime.run.bind(runtime);
		runtime.run = async (spec) => {
			started.push(spec);
			await run(spec);
		};
		await builder.scanImage(scanJob());
		expect(started[0]!.volumes![0]!.name).toBe(cacheVolume('node_1', 'scans'));
	});
});

const scanJob = (scan: DesiredScan['scan'] = 'warn'): DesiredScan => ({
	deploymentId: 'dep_2',
	image: 'traefik/whoami',
	scan
});

group('Builder.scanImage', () => {
	const DIGEST = 'traefik/whoami@sha256:abc';

	it('pulls the image and scans exactly the digest it got', async () => {
		const { runtime, builder } = setup({ report: {} });
		runtime.digests.set('traefik/whoami', DIGEST);
		const result = await builder.scanImage(scanJob());
		expect(runtime.calls).toContain('pull traefik/whoami');
		expect(trivyRun(runtime)!.cmd.slice(-3)).toEqual(['--image-src', 'remote', DIGEST]);
		expect(result).toMatchObject({ state: 'succeeded', image: DIGEST, error: null });
		expect(result.scan?.outcome).toBe('clean');
	});

	it('refuses a blocked image', async () => {
		const { runtime, builder } = setup();
		runtime.digests.set('traefik/whoami', DIGEST);
		const result = await builder.scanImage(scanJob('block'));
		expect(result).toMatchObject({
			state: 'failed',
			image: null,
			error: 'Blocked: 1 critical vulnerability with a fix available'
		});
	});

	it('handles images without a registry digest by the mode', async () => {
		const warn = setup();
		const warned = await warn.builder.scanImage(scanJob('warn'));
		expect(warned).toMatchObject({ state: 'succeeded', image: 'traefik/whoami' });
		expect(warned.scan?.error).toBe('the image has no registry digest to scan');
		expect(trivyRun(warn.runtime)).toBeUndefined();

		const blocked = await setup().builder.scanImage(scanJob('block'));
		expect(blocked).toMatchObject({
			state: 'failed',
			error: 'Blocked: the image could not be scanned (the image has no registry digest to scan)'
		});
	});

	it('reports a pull failure', async () => {
		const { runtime, builder } = setup();
		runtime.failPull.set('traefik/whoami', 'manifest unknown');
		expect(await builder.scanImage(scanJob())).toMatchObject({
			state: 'failed',
			error: 'manifest unknown'
		});
	});
});
