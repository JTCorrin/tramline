<script lang="ts">
	import { api } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { reportError } from '#lib/forms.js';
	import { timeAgo } from '#lib/format.js';
	import { cn } from '#lib/utils.js';
	import type { CronRun, Deployment } from '@tramline/contracts';
	import { toast } from 'svelte-sonner';

	let { deployment, version }: { deployment: Deployment; version: number } = $props();

	const client = api();
	let runs = $state<CronRun[]>([]);

	const STYLES: Record<CronRun['status'], string> = {
		running: 'text-sky-600 dark:text-sky-400',
		succeeded: 'text-emerald-600 dark:text-emerald-400',
		failed: 'text-destructive',
		skipped: 'text-muted-foreground'
	};

	const load = () =>
		client.deployments
			.runs(deployment.id)
			.then((list) => (runs = list))
			.catch(reportError);

	$effect(() => {
		void version;
		void load();
	});

	// runs finish on the node; check back while one is going
	$effect(() => {
		if (!runs.some((run) => run.status === 'running')) return;
		const timer = setInterval(load, 3000);
		return () => clearInterval(timer);
	});

	async function runNow() {
		try {
			await client.deployments.runNow(deployment.id);
			toast.success('Run started');
			await load();
		} catch (error) {
			reportError(error);
		}
	}
</script>

<div class="space-y-2 rounded-lg border p-3 text-sm" data-testid="cron-runs">
	<div class="flex items-center gap-2">
		<span class="flex-1 text-xs text-muted-foreground">
			{#if deployment.nextRunAt}
				Next run {Date.parse(deployment.nextRunAt) - Date.now() < 60_000
					? 'in under a minute'
					: timeAgo(deployment.nextRunAt)} (UTC schedule)
			{/if}
		</span>
		<Button variant="outline" size="sm" onclick={runNow}>Run now</Button>
	</div>
	{#if runs.length}
		<ul class="space-y-1 text-xs">
			{#each runs as run (run.id)}
				<li class="flex gap-2">
					<span class={cn('w-20 font-medium capitalize', STYLES[run.status])}>{run.status}</span>
					<span class="text-muted-foreground">
						{run.trigger === 'manual' ? 'by hand' : 'scheduled'} · {timeAgo(run.scheduledFor)}
						{#if run.exitCode !== null}· exit code {run.exitCode}{/if}
					</span>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-xs text-muted-foreground">No runs yet.</p>
	{/if}
</div>
