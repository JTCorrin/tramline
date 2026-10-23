<script lang="ts">
	import { cn } from '#lib/utils.js';
	import type { CanvasService } from '@tramline/contracts';

	let { status, class: className }: { status: CanvasService['status']; class?: string } = $props();

	const STYLES: Record<CanvasService['status'], { dot: string; label: string }> = {
		undeployed: { dot: 'bg-muted-foreground/40', label: 'Not deployed' },
		queued: { dot: 'bg-amber-400 animate-pulse', label: 'Queued' },
		building: { dot: 'bg-sky-400 animate-pulse', label: 'Building' },
		deploying: { dot: 'bg-sky-400 animate-pulse', label: 'Deploying' },
		active: { dot: 'bg-emerald-400', label: 'Online' },
		failed: { dot: 'bg-red-500', label: 'Failed' },
		crashed: { dot: 'bg-red-500', label: 'Crashed' },
		removed: { dot: 'bg-muted-foreground/40', label: 'Removed' }
	};
</script>

<span class={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
	<span class={cn('size-2 rounded-full', STYLES[status].dot)}></span>
	{STYLES[status].label}
</span>
