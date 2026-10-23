<script lang="ts">
	import { api } from '#lib/api.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { cn } from '#lib/utils.js';
	import ServerIcon from '@lucide/svelte/icons/server';
	import type { NodeSummary } from '@tramline/contracts';

	let { version }: { version: number } = $props();

	let nodes = $state<NodeSummary[]>([]);

	$effect(() => {
		void version;
		const load = () =>
			api()
				.nodes.getAll()
				.then(
					(list) => (nodes = list),
					() => {}
				);
		load();
		// node health changes without project events, so poll gently
		const timer = setInterval(load, 10_000);
		return () => clearInterval(timer);
	});

	const online = $derived(nodes.filter((n) => n.status === 'online').length);
	const problem = $derived(nodes.find((n) => n.status !== 'online'));
</script>

{#if nodes.length}
	<Tooltip.Provider>
		<Tooltip.Root>
			<Tooltip.Trigger
				class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
				data-testid="node-status"
			>
				<ServerIcon class="size-3.5" />
				<span class={cn('size-2 rounded-full', online ? 'bg-emerald-400' : 'bg-red-500')}></span>
				{online}/{nodes.length}
				{nodes.length === 1 ? 'node' : 'nodes'} online
			</Tooltip.Trigger>
			<Tooltip.Content class="max-w-xs">
				{#each nodes as n (n.id)}
					<div>
						<span class="font-medium">{n.name}</span>: {n.status}{n.dockerVersion
							? ` · Docker ${n.dockerVersion}`
							: ''}
					</div>
				{/each}
				{#if problem?.error}<div class="mt-1 opacity-80">{problem.error}</div>{/if}
				{#if problem?.status === 'offline'}
					<div class="mt-1 opacity-80">
						Start the agent with <code>pnpm dev</code> or
						<code>pnpm --filter @tramline/agent start</code>.
					</div>
				{/if}
			</Tooltip.Content>
		</Tooltip.Root>
	</Tooltip.Provider>
{/if}
