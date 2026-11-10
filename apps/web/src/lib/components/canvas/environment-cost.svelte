<script lang="ts">
	import { api } from '#lib/api.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { money } from '#lib/format.js';
	import type { EnvironmentCosts } from '@tramline/contracts';

	/**
	 * What the environment's running services cost a month: each one's part
	 * of the nodes it runs on, by the CPU, memory and GPUs it reserves.
	 */
	let { environmentId, version }: { environmentId: string; version: number } = $props();

	let costs = $state<EnvironmentCosts | null>(null);

	$effect(() => {
		void version;
		api()
			.environments.costs(environmentId)
			.then(
				(c) => (costs = c),
				() => (costs = null)
			);
	});

	const shown = $derived(
		costs && (costs.spent > 0 || (costs.services.length && (costs.monthly > 0 || !costs.complete)))
			? costs
			: null
	);
</script>

{#if shown}
	<Popover.Root>
		<Popover.Trigger
			class="rounded-md px-2 py-1 text-xs text-muted-foreground tabular-nums hover:bg-accent"
			data-testid="environment-cost"
		>
			≈ {money(shown.monthly)}/mo{shown.complete ? '' : '+'}
		</Popover.Trigger>
		<Popover.Content class="w-80 text-sm" align="end">
			<p class="mb-2 text-xs text-muted-foreground">
				Each service's part of the nodes it runs on, by the CPU, memory and GPUs it reserves. What
				nothing reserves isn't counted.
			</p>
			<ul class="space-y-1" data-testid="service-costs">
				{#each shown.services as s (s.serviceId)}
					<li class="flex items-baseline gap-2">
						<span class="truncate">{s.name}</span>
						<span class="ml-auto shrink-0 text-right text-xs tabular-nums">
							{#if s.monthly === null}
								<span class="text-muted-foreground">on an unpriced node</span>
							{:else if s.unreserved}
								<span class="text-muted-foreground">reserves nothing</span>
							{:else}
								{money(s.monthly)}/mo
							{/if}
							{#if s.spent > 0}
								<span class="block text-muted-foreground">{money(s.spent)} this month</span>
							{/if}
						</span>
					</li>
				{/each}
			</ul>
			<p class="mt-3 flex border-t pt-2 text-xs" data-testid="environment-spent">
				<span>Spent this month</span>
				<span class="ml-auto tabular-nums">{money(shown.spent)}</span>
			</p>
			{#if !shown.complete}
				<p class="mt-2 text-xs text-muted-foreground">
					Some nodes have no price. An install admin can enter what they cost on the Nodes page.
				</p>
			{/if}
		</Popover.Content>
	</Popover.Root>
{/if}
