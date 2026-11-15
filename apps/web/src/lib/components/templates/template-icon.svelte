<script lang="ts">
	import { cn } from '#lib/utils.js';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import LayoutTemplateIcon from '@lucide/svelte/icons/layout-template';
	import WorkflowIcon from '@lucide/svelte/icons/workflow';
	import ZapIcon from '@lucide/svelte/icons/zap';

	let { icon, class: className }: { icon: string; class?: string } = $props();

	const ICONS = {
		supabase: { Icon: ZapIcon, color: 'text-emerald-400' },
		workflow: { Icon: WorkflowIcon, color: 'text-rose-400' },
		activity: { Icon: ActivityIcon, color: 'text-green-400' },
		postgres: { Icon: DatabaseIcon, color: 'text-sky-400' }
	} as const;
	const shown = $derived(
		ICONS[icon as keyof typeof ICONS] ?? {
			Icon: LayoutTemplateIcon,
			color: 'text-muted-foreground'
		}
	);
</script>

<span
	class={cn(
		'flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted',
		shown.color,
		className
	)}
>
	<shown.Icon class="size-5" />
</span>
