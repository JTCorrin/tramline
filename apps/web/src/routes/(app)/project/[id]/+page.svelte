<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>{data.project.name} · Tramline</title></svelte:head>

<div class="flex h-11 items-center border-b px-4 text-sm font-medium">{data.project.name}</div>

<!-- Phase 1 replaces this with the Svelte Flow canvas -->
<main
	class="flex flex-1 items-center justify-center bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:20px_20px]"
>
	<p class="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
		The canvas arrives in Phase 1. Right-click to add services will live here.
	</p>
</main>
