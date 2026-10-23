<script lang="ts">
	import { cn } from '#lib/utils.js';

	let { class: className, withWordmark = false }: { class?: string; withWordmark?: boolean } =
		$props();
</script>

<span class={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
	<svg viewBox="0 0 24 24" class="size-6" aria-hidden="true">
		<rect width="24" height="24" rx="6" class="fill-foreground" />
		<path
			d="M6 9h12M6 15h12M9 6v12M15 6v12"
			class="stroke-background"
			stroke-width="2"
			stroke-linecap="round"
		/>
	</svg>
	{#if withWordmark}<span>Tramline</span>{/if}
</span>
