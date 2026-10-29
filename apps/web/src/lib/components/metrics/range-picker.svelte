<script lang="ts">
	import { METRIC_RANGES, type MetricRange } from '@tramline/contracts';
	import { cn } from '#lib/utils.js';

	let { range = $bindable() }: { range: MetricRange } = $props();
</script>

<div class="inline-flex rounded-md border p-0.5 text-xs" role="group" aria-label="Time range">
	{#each METRIC_RANGES as option (option)}
		<button
			type="button"
			aria-pressed={range === option}
			class={cn(
				'rounded px-2 py-0.5 text-muted-foreground hover:text-foreground',
				range === option && 'bg-muted font-medium text-foreground'
			)}
			onclick={() => (range = option)}>{option}</button
		>
	{/each}
</div>
