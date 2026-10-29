<script lang="ts">
	import { api } from '#lib/api.js';
	import { formatMb, formatPercent } from '#lib/format.js';
	import { reportError } from '#lib/forms.js';
	import type { MetricRange, NodeMetrics } from '@tramline/contracts';
	import MetricPanel from './metric-panel.svelte';
	import RangePicker from './range-picker.svelte';

	let { nodeId }: { nodeId: string } = $props();

	const client = api();
	let range = $state<MetricRange>('1h');
	let data = $state<NodeMetrics | null>(null);
	let now = $state(Date.now());

	const load = () =>
		client.metrics
			.node(nodeId, range)
			.then((metrics) => {
				data = metrics;
				now = Date.now();
			})
			.catch(reportError);

	$effect(() => {
		void range;
		void load();
		const timer = setInterval(load, 30_000);
		return () => clearInterval(timer);
	});

	const RANGE_MS: Record<MetricRange, number> = {
		'1h': 3600_000,
		'6h': 6 * 3600_000,
		'24h': 86_400_000,
		'7d': 7 * 86_400_000,
		'30d': 30 * 86_400_000
	};
	const from = $derived(now - RANGE_MS[range]);
	const points = $derived(data?.points ?? []);
	const latest = $derived(points.at(-1));
	const at = (iso: string) => Date.parse(iso);
	const disk = $derived(points.findLast((p) => p.diskTotalMb));
</script>

<div class="space-y-3" data-testid="node-metrics">
	<div class="flex items-center gap-2">
		{#if disk?.diskTotalMb && disk.diskUsedMb !== null}
			{@const used = disk.diskUsedMb / disk.diskTotalMb}
			<div
				class="flex flex-1 items-center gap-2 text-xs text-muted-foreground"
				data-testid="node-disk"
			>
				<span>Disk</span>
				<div
					class="h-1.5 w-32 overflow-hidden rounded-full bg-muted"
					role="meter"
					aria-label="Disk used"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round(used * 100)}
				>
					<div
						class="h-full {used >= 0.9 ? 'bg-destructive' : 'bg-foreground/60'}"
						style="width: {Math.min(100, used * 100)}%"
					></div>
				</div>
				<span
					>{formatMb(disk.diskUsedMb)} of {formatMb(disk.diskTotalMb)} ({formatPercent(
						used * 100
					)})</span
				>
			</div>
		{:else}
			<span class="flex-1"></span>
		{/if}
		<RangePicker bind:range />
	</div>
	{#if data}
		<div class="grid gap-3 md:grid-cols-2">
			<MetricPanel
				title="CPU"
				headline={latest ? formatPercent(latest.cpuPercent) : null}
				series={[{ label: 'CPU', color: 'var(--series-1)' }]}
				points={points.map((p) => ({ at: at(p.at), values: [p.cpuPercent] }))}
				step={data.step}
				format={formatPercent}
				max={100}
				{from}
				to={now}
			/>
			<MetricPanel
				title="Memory"
				headline={latest
					? `${formatMb(latest.memoryUsedMb)} of ${formatMb(latest.memoryTotalMb)}`
					: null}
				series={[{ label: 'Memory', color: 'var(--series-1)' }]}
				points={points.map((p) => ({ at: at(p.at), values: [p.memoryUsedMb] }))}
				step={data.step}
				format={formatMb}
				max={latest?.memoryTotalMb ?? null}
				{from}
				to={now}
			/>
		</div>
	{/if}
</div>
