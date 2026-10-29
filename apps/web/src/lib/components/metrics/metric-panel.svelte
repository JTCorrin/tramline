<script lang="ts">
	import LineChart, { type ChartPoint, type Series } from './line-chart.svelte';

	/** A titled chart with its latest value, and the same numbers as a table. */
	let {
		title,
		headline,
		...chart
	}: {
		title: string;
		/** The latest value in words, e.g. "212 MB of 512 MB". */
		headline: string | null;
		series: Series[];
		points: ChartPoint[];
		step: number;
		format: (value: number) => string;
		from: number;
		to: number;
		limit?: { value: number; label: string } | null;
		max?: number | null;
	} = $props();

	let table = $state(false);
	const time = new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
</script>

<section class="space-y-1 rounded-lg border p-3" data-testid="metric-panel">
	<header class="flex items-baseline gap-2">
		<h3 class="text-sm font-medium">{title}</h3>
		{#if headline}<span class="text-sm text-muted-foreground">{headline}</span>{/if}
		<button
			type="button"
			class="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline"
			aria-expanded={table}
			onclick={() => (table = !table)}>{table ? 'Chart' : 'Table'}</button
		>
	</header>
	{#if !chart.points.length}
		<p class="py-8 text-center text-xs text-muted-foreground">No data for this range yet.</p>
	{:else if table}
		<div class="max-h-56 overflow-y-auto">
			<table class="w-full text-xs">
				<thead class="sticky top-0 bg-card text-left text-muted-foreground">
					<tr>
						<th class="py-1 font-normal">Time</th>
						{#each chart.series as s (s.label)}<th class="py-1 text-right font-normal">{s.label}</th
							>{/each}
					</tr>
				</thead>
				<tbody>
					{#each chart.points.toReversed() as point (point.at)}
						<tr class="border-t">
							<td class="py-1 text-muted-foreground">{time.format(point.at)}</td>
							{#each point.values as value, i (i)}
								<td class="py-1 text-right tabular-nums"
									>{value === null ? '—' : chart.format(value)}</td
								>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<LineChart label={title} {...chart} />
	{/if}
</section>
