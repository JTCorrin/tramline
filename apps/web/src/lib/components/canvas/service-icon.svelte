<script lang="ts">
	import { cn } from '#lib/utils.js';
	import BoxIcon from '@lucide/svelte/icons/box';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import SquareDashedIcon from '@lucide/svelte/icons/square-dashed';
	import type { ServiceKind } from '@tramline/contracts';

	let {
		kind,
		icon,
		class: className
	}: { kind: ServiceKind; icon: string | null; class?: string } = $props();

	const ENGINE_COLORS: Record<string, string> = {
		postgres: 'text-sky-400',
		mysql: 'text-orange-400',
		redis: 'text-red-400',
		mongo: 'text-emerald-400'
	};

	const Icon = $derived(
		kind === 'database'
			? DatabaseIcon
			: kind === 'repo'
				? GitBranchIcon
				: kind === 'image'
					? BoxIcon
					: SquareDashedIcon
	);
</script>

<span
	class={cn(
		'flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted',
		icon && ENGINE_COLORS[icon],
		className
	)}
>
	<Icon class="size-4" />
</span>
