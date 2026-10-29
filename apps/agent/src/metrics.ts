import type { ContainerSample, DesiredState, MetricsBatch, NodeSample } from '@tramline/contracts';
import { readFileSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { LABELS, type ContainerRuntime, type ContainerStats } from './runtime';

const MB = 1024 * 1024;

interface CpuTimes {
	busy: number;
	total: number;
}

/** The machine's CPU time from /proc/stat (in clock ticks); iowait counts as idle. */
export function readCpu(procDir: string): CpuTimes | null {
	try {
		const line = readFileSync(path.join(procDir, 'stat'), 'utf8').split('\n')[0]!;
		const [, ...fields] = line.trim().split(/\s+/);
		const ticks = fields.slice(0, 8).map(Number);
		if (ticks.length < 4 || ticks.some((t) => !Number.isFinite(t))) return null;
		const total = ticks.reduce((sum, t) => sum + t, 0);
		const idle = ticks[3]! + (ticks[4] ?? 0);
		return { busy: total - idle, total };
	} catch {
		return null;
	}
}

/** Memory in use, from /proc/meminfo: total less what's available without swapping. */
export function readMemory(procDir: string): { usedMb: number; totalMb: number } | null {
	try {
		const info = readFileSync(path.join(procDir, 'meminfo'), 'utf8');
		const kb = (key: string) => Number(info.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))?.[1]);
		const total = kb('MemTotal');
		const available = kb('MemAvailable');
		if (!total || !Number.isFinite(available)) return null;
		return { usedMb: Math.round((total - available) / 1024), totalMb: Math.round(total / 1024) };
	} catch {
		return null;
	}
}

export function readDisk(dir: string): { usedMb: number; totalMb: number } | null {
	try {
		const fs = statfsSync(dir);
		const total = fs.blocks * fs.bsize;
		// what's free to anyone, not just root, like df
		const used = total - fs.bfree * fs.bsize;
		return { usedMb: Math.round(used / MB), totalMb: Math.round(total / MB) };
	} catch {
		return null;
	}
}

export interface MetricsOptions {
	/** Where /proc is; the agent's container sees the host's CPU and memory there. */
	procDir?: string;
	/** A directory on the disk Docker uses: the agent's state volume. */
	diskDir: string;
	now?: () => number;
}

/**
 * Samples the node and the workloads it runs. Docker and /proc give counters
 * that only grow, so each sample is the change since the previous one; the
 * first sample of a container only sets its baseline.
 */
export class MetricsSampler {
	#cpu: CpuTimes | null = null;
	#containers = new Map<string, { at: number; stats: ContainerStats }>();
	#procDir: string;
	#now: () => number;

	constructor(
		private runtime: Pick<ContainerRuntime, 'list' | 'stats'>,
		private options: MetricsOptions
	) {
		this.#procDir = options.procDir ?? '/proc';
		this.#now = options.now ?? Date.now;
	}

	node(): NodeSample | null {
		const cpu = readCpu(this.#procDir);
		const memory = readMemory(this.#procDir);
		const previous = this.#cpu;
		this.#cpu = cpu;
		if (!cpu || !memory || !previous || cpu.total <= previous.total) return null;
		const disk = readDisk(this.options.diskDir);
		const cpuPercent = ((cpu.busy - previous.busy) / (cpu.total - previous.total)) * 100;
		return {
			cpuPercent: Math.min(100, Math.max(0, round(cpuPercent))),
			memoryUsedMb: memory.usedMb,
			memoryTotalMb: memory.totalMb,
			diskUsedMb: disk?.usedMb ?? null,
			diskTotalMb: disk?.totalMb ?? null
		};
	}

	async containers(desired: DesiredState | null): Promise<ContainerSample[]> {
		const wanted = new Map((desired?.containers ?? []).map((c) => [c.name, c]));
		const running = (await this.runtime.list()).filter(
			(c) =>
				c.status === 'running' && wanted.get(c.name)?.deploymentId === c.labels[LABELS.deployment]
		);
		const samples: ContainerSample[] = [];
		const seen = new Set<string>();
		for (const container of running) {
			const spec = wanted.get(container.name)!;
			const stats = await this.runtime.stats(container.name).catch(() => null);
			if (!stats) continue;
			// keyed by deployment too, so a replacement container starts a fresh baseline
			const key = `${container.name}/${spec.deploymentId}`;
			seen.add(key);
			const at = this.#now();
			const previous = this.#containers.get(key);
			this.#containers.set(key, { at, stats });
			// counters reset when a container restarts
			if (!previous || stats.cpuNs < previous.stats.cpuNs || at <= previous.at) continue;
			const seconds = (at - previous.at) / 1000;
			const limitMb = stats.memoryLimitBytes / MB;
			samples.push({
				deploymentId: spec.deploymentId,
				replica: spec.replica,
				cpuPercent: round(((stats.cpuNs - previous.stats.cpuNs) / 1e9 / seconds) * 100),
				memoryMb: round(stats.memoryBytes / MB),
				// Docker reports the host's memory as the limit of a container without one
				memoryLimitMb: spec.memoryMb ? round(limitMb) : null,
				rxBytes: Math.max(0, stats.rxBytes - previous.stats.rxBytes),
				txBytes: Math.max(0, stats.txBytes - previous.stats.txBytes)
			});
		}
		for (const key of this.#containers.keys()) if (!seen.has(key)) this.#containers.delete(key);
		return samples;
	}

	async sample(desired: DesiredState | null): Promise<MetricsBatch> {
		return {
			at: new Date(this.#now()).toISOString(),
			node: this.node(),
			containers: await this.containers(desired)
		};
	}
}

const round = (value: number) => Math.round(value * 100) / 100;
