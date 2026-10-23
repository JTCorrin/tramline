<script lang="ts">
	import Logo from '#lib/components/logo.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<main
	class="flex min-h-svh flex-col items-center justify-center gap-8 bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:20px_20px] p-6"
>
	<Logo class="text-lg" withWordmark />
	<div class="w-full max-w-sm">
		{@render children()}
	</div>
</main>
