<script lang="ts">
	import { api } from '#lib/api.js';
	import { formatMb, formatPercent, formatRate } from '#lib/format.js';
	import { reportError } from '#lib/forms.js';
	import type { Alert, MetricRange, ServiceMetrics } from '@tramline/contracts';
	import AlertList from './alert-list.svelte';
	import MetricPanel from './metric-panel.svelte';
	import RangePicker from './range-picker.svelte';

	let { serviceId, environmentId }: { serviceId: string; environmentId: string } = $props();

	const client = api();
	let range = $state<MetricRange>('1h');
	let data = $state<ServiceMetrics | null>(null);
	let alerts = $state<Alert[]>([]);
	let now = $state(Date.now());

	const load = () =>
		Promise.all([client.metrics.service(serviceId, environmentId, range), client.metrics.alerts()])
			.then(([metrics, list]) => {
				data = metrics;
				alerts = list.filter((a) => a.serviceId === serviceId && a.environmentId === environmentId);
				now = Date.now();
			})
			.catch(reportError);

	// agents send samples every 15 seconds; minute buckets fill as they arrive
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
	const limit = $derived(latest?.memoryLimitMb ?? null);
</script>

<div class="space-y-3" data-testid="service-metrics">
	<div class="flex items-center gap-2">
		<p class="flex-1 text-xs text-muted-foreground">
			Summed over replicas. {range === '7d' || range === '30d'
				? 'Hourly averages.'
				: 'Minute averages.'}
		</p>
		<RangePicker bind:range />
	</div>

	<AlertList alerts={alerts.filter((a) => !a.resolvedAt)} />

	{#if data}
		<MetricPanel
			title="CPU"
			headline={latest ? `${formatPercent(latest.cpuPercent)} of a core` : null}
			series={[{ label: 'CPU', color: 'var(--series-1)' }]}
			points={points.map((p) => ({ at: at(p.at), values: [p.cpuPercent] }))}
			step={data.step}
			format={formatPercent}
			{from}
			to={now}
		/>
		<MetricPanel
			title="Memory"
			headline={latest
				? `${formatMb(latest.memoryMb)}${limit ? ` of ${formatMb(limit)}` : ''}`
				: null}
			series={[{ label: 'Memory', color: 'var(--series-1)' }]}
			points={points.map((p) => ({ at: at(p.at), values: [p.memoryMb] }))}
			step={data.step}
			format={formatMb}
			limit={limit ? { value: limit, label: `Limit ${formatMb(limit)}` } : null}
			{from}
			to={now}
		/>
		<MetricPanel
			title="Network"
			headline={latest
				? `${formatRate(latest.rxBytesPerSecond)} in · ${formatRate(latest.txBytesPerSecond)} out`
				: null}
			series={[
				{ label: 'In', color: 'var(--series-1)' },
				{ label: 'Out', color: 'var(--series-2)' }
			]}
			points={points.map((p) => ({
				at: at(p.at),
				values: [p.rxBytesPerSecond, p.txBytesPerSecond]
			}))}
			step={data.step}
			format={formatRate}
			{from}
			to={now}
		/>
	{/if}
</div>
