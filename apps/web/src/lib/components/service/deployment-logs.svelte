<script lang="ts">
	import { cn } from '#lib/utils.js';
	import type { LogLine } from '@tramline/contracts';

	let { deploymentId }: { deploymentId: string } = $props();

	const MAX_LINES = 2000;
	let lines = $state<LogLine[]>([]);
	let ready = $state(false);
	let viewport = $state<HTMLElement>();
	let follow = $state(true);

	$effect(() => {
		lines = [];
		ready = false;
		const source = new EventSource(`/api/v1/deployments/${deploymentId}/logs`);
		source.onmessage = (event) => {
			const next = [...lines, JSON.parse(event.data) as LogLine];
			lines = next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
		};
		source.addEventListener('ready', () => (ready = true));
		return () => source.close();
	});

	// stick to the bottom unless the user scrolled up to read
	$effect(() => {
		void lines.length;
		if (follow && viewport) viewport.scrollTop = viewport.scrollHeight;
	});

	const time = (ts: string) => ts.slice(11, 19);
</script>

<div
	bind:this={viewport}
	onscroll={() => {
		if (!viewport) return;
		follow = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
	}}
	class="max-h-80 overflow-auto rounded-md border bg-black/40 p-2 font-mono text-[11px] leading-relaxed"
	data-testid="deployment-logs"
>
	{#each lines as line, i (i)}
		<div
			class={cn(
				'flex gap-2 whitespace-pre-wrap',
				line.stream === 'stderr' && 'text-red-300',
				line.stream === 'system' && 'text-sky-300'
			)}
		>
			<span class="shrink-0 text-muted-foreground select-none">{time(line.ts)}</span>
			<span class="break-all">{line.line}</span>
		</div>
	{:else}
		<div class="text-muted-foreground">{ready ? 'No logs yet.' : 'Connecting…'}</div>
	{/each}
</div>
