import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MetricsSampler, readCpu, readDisk, readMemory } from './metrics';
import { LABELS } from './runtime';
import { FakeRuntime, desiredContainer, desiredState } from './testing';

const MB = 1024 * 1024;

function proc(busy: number, idle: number, availableKb = 6_144_000) {
	const dir = mkdtempSync(path.join(tmpdir(), 'tramline-proc-'));
	write(dir, busy, idle, availableKb);
	return dir;
}

function write(dir: string, busy: number, idle: number, availableKb = 6_144_000) {
	// user nice system idle iowait irq softirq steal: busy split over user and system
	writeFileSync(
		path.join(dir, 'stat'),
		`cpu  ${busy / 2} 0 ${busy / 2} ${idle} 0 0 0 0 0 0\ncpu0 1 2 3 4\n`
	);
	writeFileSync(
		path.join(dir, 'meminfo'),
		`MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:   ${availableKb} kB\n`
	);
}

function running(runtime: FakeRuntime, name: string, deploymentId: string) {
	runtime.containers.set(name, {
		name,
		labels: { [LABELS.managed]: 'true', [LABELS.deployment]: deploymentId },
		networks: [],
		status: 'running',
		exitCode: null,
		restartCount: 0,
		startedAt: '2026-10-29T10:00:00Z',
		spec: {} as never
	});
}

describe('reading the machine', () => {
	it('reads CPU time, counting iowait as idle', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'tramline-proc-'));
		writeFileSync(path.join(dir, 'stat'), 'cpu  100 20 30 800 50 0 0 0 0 0\n');
		expect(readCpu(dir)).toEqual({ busy: 150, total: 1000 });
	});

	it('reads memory in use as total less available', () => {
		expect(readMemory(proc(0, 0, 4_096_000))).toEqual({ usedMb: 12000, totalMb: 16000 });
	});

	it('reads the disk, and gives up quietly where it cannot', () => {
		const disk = readDisk(tmpdir())!;
		expect(disk.totalMb).toBeGreaterThan(0);
		expect(disk.usedMb).toBeLessThanOrEqual(disk.totalMb);
		expect(readDisk('/nonexistent/dir')).toBeNull();
		expect(readCpu('/nonexistent/proc')).toBeNull();
		expect(readMemory('/nonexistent/proc')).toBeNull();
		const garbled = mkdtempSync(path.join(tmpdir(), 'tramline-proc-'));
		writeFileSync(path.join(garbled, 'stat'), 'cpu  x y\n');
		writeFileSync(path.join(garbled, 'meminfo'), 'nothing useful\n');
		expect(readCpu(garbled)).toBeNull();
		expect(readMemory(garbled)).toBeNull();
	});
});

describe('MetricsSampler', () => {
	it("measures the node's CPU between samples", () => {
		const dir = proc(1000, 9000);
		const sampler = new MetricsSampler(new FakeRuntime(), { procDir: dir, diskDir: tmpdir() });
		// the first sample only sets the baseline
		expect(sampler.node()).toBeNull();
		write(dir, 1000 + 250, 9000 + 750);
		expect(sampler.node()).toMatchObject({
			cpuPercent: 25,
			memoryUsedMb: 10000,
			memoryTotalMb: 16000,
			diskTotalMb: expect.any(Number)
		});
		// no time passed: nothing to measure
		expect(sampler.node()).toBeNull();
	});

	it('measures each workload container between samples, and starts over when it restarts', async () => {
		const runtime = new FakeRuntime();
		running(runtime, 'tl-dep_1-0', 'dep_1');
		running(runtime, 'tl-dep_2-0', 'dep_2');
		// a container from another deployment's spec, and an agent-owned one, aren't sampled
		running(runtime, 'tl-ingress', 'none');
		let now = 1_000_000;
		const sampler = new MetricsSampler(runtime, {
			procDir: proc(0, 0),
			diskDir: tmpdir(),
			now: () => now
		});
		const desired = desiredState([
			desiredContainer({ name: 'tl-dep_1-0', deploymentId: 'dep_1', memoryMb: 512 }),
			desiredContainer({ name: 'tl-dep_2-0', deploymentId: 'dep_3', replica: 1 })
		]);
		const stats = (cpuSeconds: number, rx: number) => ({
			cpuNs: cpuSeconds * 1e9,
			memoryBytes: 200 * MB,
			memoryLimitBytes: 512 * MB,
			rxBytes: rx,
			txBytes: rx / 2
		});
		runtime.containerStats.set('tl-dep_1-0', stats(10, 1000));
		runtime.containerStats.set('tl-dep_2-0', stats(10, 1000));
		expect(await sampler.containers(desired)).toEqual([]);

		now += 10_000;
		runtime.containerStats.set('tl-dep_1-0', stats(15, 6000));
		expect(await sampler.containers(desired)).toEqual([
			{
				deploymentId: 'dep_1',
				replica: 0,
				// 5 CPU seconds in 10 seconds: half a core
				cpuPercent: 50,
				memoryMb: 200,
				memoryLimitMb: 512,
				rxBytes: 5000,
				txBytes: 2500
			}
		]);

		// a restart resets Docker's counters: that sample only sets a new baseline
		now += 10_000;
		runtime.containerStats.set('tl-dep_1-0', stats(1, 10));
		expect(await sampler.containers(desired)).toEqual([]);
		now += 10_000;
		runtime.containerStats.set('tl-dep_1-0', stats(3, 20));
		expect((await sampler.containers(desired))[0]).toMatchObject({ cpuPercent: 20, rxBytes: 10 });

		// without a desired state there is nothing to sample
		expect(await sampler.containers(null)).toEqual([]);
	});

	it('starts a new baseline after a restart even when the new counters exceed the old ones', async () => {
		const runtime = new FakeRuntime();
		running(runtime, 'tl-dep_1-0', 'dep_1');
		let now = 1000;
		const sampler = new MetricsSampler(runtime, { diskDir: tmpdir(), now: () => now });
		const desired = desiredState([desiredContainer()]);
		runtime.containerStats.set('tl-dep_1-0', {
			cpuNs: 1e9,
			memoryBytes: MB,
			memoryLimitBytes: MB,
			rxBytes: 10,
			txBytes: 10
		});
		await sampler.containers(desired);
		runtime.containers.get('tl-dep_1-0')!.startedAt = '2026-10-29T10:00:01Z';
		now += 15000;
		runtime.containerStats.set('tl-dep_1-0', {
			cpuNs: 2e9,
			memoryBytes: MB,
			memoryLimitBytes: MB,
			rxBytes: 20,
			txBytes: 20
		});
		expect(await sampler.containers(desired)).toEqual([]);
	});

	it('reports no limit for a container without one', async () => {
		const runtime = new FakeRuntime();
		running(runtime, 'tl-dep_1-0', 'dep_1');
		let now = 0;
		const sampler = new MetricsSampler(runtime, {
			procDir: proc(0, 0),
			diskDir: tmpdir(),
			now: () => now
		});
		const desired = desiredState([desiredContainer()]);
		const host = { memoryBytes: MB, memoryLimitBytes: 16_000 * MB, rxBytes: 0, txBytes: 0 };
		runtime.containerStats.set('tl-dep_1-0', { ...host, cpuNs: 0 });
		await sampler.containers(desired);
		now += 1000;
		runtime.containerStats.set('tl-dep_1-0', { ...host, cpuNs: 1e9 });
		const batch = await sampler.sample(desired);
		expect(batch.containers[0]).toMatchObject({ cpuPercent: 100, memoryLimitMb: null });
		expect(batch.at).toBe(new Date(1000).toISOString());
	});
});
