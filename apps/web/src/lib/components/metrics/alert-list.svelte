<script lang="ts">
	import { timeAgo } from '#lib/format.js';
	import type { Alert } from '@tramline/contracts';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';

	let { alerts }: { alerts: Alert[] } = $props();
</script>

{#if alerts.length}
	<ul class="divide-y rounded-lg border text-sm" data-testid="alerts">
		{#each alerts as alert (alert.id)}
			<li class="flex items-start gap-2 px-3 py-2" data-testid="alert">
				{#if alert.resolvedAt}
					<CircleCheckIcon class="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
				{:else}
					<CircleAlertIcon class="mt-0.5 size-4 shrink-0 text-destructive" />
				{/if}
				<span class="flex-1" class:text-muted-foreground={alert.resolvedAt}>{alert.message}</span>
				<span class="shrink-0 text-xs text-muted-foreground">
					{alert.resolvedAt
						? `Resolved ${timeAgo(alert.resolvedAt)}`
						: `Since ${timeAgo(alert.openedAt)}`}
				</span>
			</li>
		{/each}
	</ul>
{/if}
