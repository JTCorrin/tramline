<script lang="ts">
	import { api } from '#lib/api.js';
	import StatusBadge from '#lib/components/canvas/status-badge.svelte';
	import { reportError } from '#lib/forms.js';
	import { timeAgo } from '#lib/format.js';
	import type { Deployment } from '@tramline/contracts';

	let {
		serviceId,
		environmentId,
		version
	}: { serviceId: string; environmentId: string; version: number } = $props();

	let deployments = $state<Deployment[]>();

	$effect(() => {
		void version;
		api()
			.deployments.getAll({ serviceId, environmentId })
			.then((list) => (deployments = list))
			.catch(reportError);
	});
</script>

{#if deployments?.length === 0}
	<div class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
		<p class="font-medium text-foreground">No deployments yet</p>
		<p class="mt-1">Deploy the staged changes to create the first one.</p>
	</div>
{:else if deployments}
	<ul class="divide-y rounded-lg border" data-testid="deployments">
		{#each deployments as deployment, i (deployment.id)}
			<li class="flex items-center gap-3 px-3 py-3">
				<StatusBadge status={deployment.status} class="w-24" />
				<div class="min-w-0 flex-1">
					<div class="truncate font-mono text-xs">{deployment.source}</div>
					<div class="text-xs text-muted-foreground">
						{timeAgo(deployment.createdAt)} · {deployment.id.slice(4, 12)}
					</div>
				</div>
				{#if i === 0 && deployment.status === 'queued'}
					<span class="text-xs text-muted-foreground" title="Agents arrive in Phase 2">
						waiting for an agent
					</span>
				{/if}
			</li>
		{/each}
	</ul>
{/if}
