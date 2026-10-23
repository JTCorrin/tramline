<script lang="ts" module>
	import type { CanvasService } from '@tramline/contracts';
	import type { Node } from '@xyflow/svelte';

	export type ServiceNodeType = Node<{ service: CanvasService }, 'service'>;
</script>

<script lang="ts">
	import { cn } from '#lib/utils.js';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import ServiceIcon from './service-icon.svelte';
	import StatusBadge from './status-badge.svelte';

	let { data, selected }: NodeProps<ServiceNodeType> = $props();
	const service = $derived(data.service);
</script>

<div
	class={cn(
		'relative w-64 rounded-xl border bg-card p-4 text-card-foreground shadow-sm transition-colors',
		selected ? 'border-foreground/60 ring-2 ring-foreground/10' : 'hover:border-foreground/30'
	)}
	data-testid="service-node"
>
	{#if service.staged}
		<span
			class="absolute -top-2 -right-2 rounded-full border bg-amber-400 px-1.5 text-[10px] font-medium text-black"
			title="This service has changes that are not deployed yet"
		>
			staged
		</span>
	{/if}
	<div class="flex items-center gap-3">
		<ServiceIcon kind={service.kind} icon={service.icon} />
		<div class="min-w-0">
			<div class="truncate font-medium">{service.name}</div>
			<div class="truncate font-mono text-xs text-muted-foreground">
				{service.source ?? 'No source'}
			</div>
		</div>
	</div>
	<div class="mt-4 flex items-center justify-between">
		<StatusBadge status={service.status} />
		{#if service.publicDomain}
			<GlobeIcon class="size-3.5 text-muted-foreground" aria-label="Public domain" />
		{/if}
	</div>
	<Handle type="target" position={Position.Left} class="opacity-0" isConnectable={false} />
	<Handle type="source" position={Position.Right} class="opacity-0" isConnectable={false} />
</div>
