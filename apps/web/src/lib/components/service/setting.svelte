<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		label,
		for: htmlFor,
		description,
		staged = false,
		children
	}: {
		label: string;
		for?: string;
		description?: string;
		staged?: boolean;
		children: Snippet;
	} = $props();
</script>

<div class="grid gap-1.5">
	<label for={htmlFor} class="flex items-center gap-2 text-sm font-medium">
		{label}
		{#if staged}
			<span class="size-1.5 rounded-full bg-amber-400" title="Changed, not deployed yet"></span>
		{/if}
	</label>
	{@render children()}
	{#if description}<p class="text-xs text-muted-foreground">{description}</p>{/if}
</div>
