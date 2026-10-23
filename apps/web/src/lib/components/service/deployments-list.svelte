<script lang="ts">
	import { api } from '#lib/api.js';
	import StatusBadge from '#lib/components/canvas/status-badge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { reportError } from '#lib/forms.js';
	import { timeAgo } from '#lib/format.js';
	import { cn } from '#lib/utils.js';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import type { Deployment } from '@tramline/contracts';
	import { toast } from 'svelte-sonner';
	import DeploymentLogs from './deployment-logs.svelte';

	let {
		serviceId,
		environmentId,
		version
	}: { serviceId: string; environmentId: string; version: number } = $props();

	const client = api();
	let deployments = $state<Deployment[]>();
	let open = $state<string | null>(null);
	/** Set once the user opens or closes logs themselves; until then, follow the newest deployment. */
	let chosen = $state(false);

	$effect(() => {
		void version;
		client.deployments
			.getAll({ serviceId, environmentId })
			.then((list) => {
				deployments = list;
				// new deployments (e.g. from a push) take over the log view unless the user picked one
				if (!chosen && list[0]) open = list[0].id;
			})
			.catch(reportError);
	});

	const RUNNING = new Set(['queued', 'building', 'deploying', 'active', 'crashed']);
	const latestLive = $derived(deployments?.find((d) => d.status === 'active')?.id);

	async function act(action: 'redeploy' | 'remove', deployment: Deployment, label: string) {
		try {
			const result = await client.deployments[action](deployment.id);
			toast.success(label);
			if (action === 'redeploy') open = result.id;
		} catch (error) {
			reportError(error);
		}
	}
</script>

{#if deployments?.length === 0}
	<div class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
		<p class="font-medium text-foreground">No deployments yet</p>
		<p class="mt-1">Deploy the staged changes to create the first one.</p>
	</div>
{:else if deployments}
	<ul class="divide-y rounded-lg border" data-testid="deployments">
		{#each deployments as deployment, i (deployment.id)}
			<li class="px-3 py-3">
				<div class="flex items-center gap-3">
					<button
						type="button"
						class="flex min-w-0 flex-1 items-center gap-3 text-left"
						aria-expanded={open === deployment.id}
						aria-label="Logs for {deployment.id}"
						onclick={() => {
							chosen = true;
							open = open === deployment.id ? null : deployment.id;
						}}
					>
						<ChevronRightIcon
							class={cn(
								'size-4 shrink-0 text-muted-foreground transition-transform',
								open === deployment.id && 'rotate-90'
							)}
						/>
						<StatusBadge status={deployment.status} class="w-24 shrink-0" />
						<div class="min-w-0 flex-1">
							<div class="truncate font-mono text-xs">
								{deployment.source}
								{#if deployment.commit}
									<span class="text-muted-foreground" title={deployment.commit}>
										· {deployment.commit.slice(0, 7)}
									</span>
								{/if}
							</div>
							<div class="truncate text-xs text-muted-foreground">
								{timeAgo(deployment.createdAt)} · {deployment.id.slice(4, 12)}
							</div>
							{#if deployment.message}
								<div class="mt-0.5 text-xs text-muted-foreground" data-testid="deployment-message">
									{deployment.message}
								</div>
							{/if}
						</div>
					</button>
					<div class="flex shrink-0 gap-1">
						{#if i === 0}
							<Button
								variant="outline"
								size="sm"
								onclick={() => act('redeploy', deployment, 'Redeploying')}
							>
								Redeploy
							</Button>
						{:else if deployment.status === 'removed' && deployment.id !== latestLive}
							<Button
								variant="ghost"
								size="sm"
								onclick={() => act('redeploy', deployment, 'Rolling back')}
							>
								Rollback
							</Button>
						{/if}
						{#if RUNNING.has(deployment.status)}
							<Button
								variant="ghost"
								size="sm"
								onclick={() => act('remove', deployment, 'Removed')}
							>
								Remove
							</Button>
						{/if}
					</div>
				</div>
				{#if open === deployment.id}
					<div class="mt-3">
						<DeploymentLogs deploymentId={deployment.id} />
					</div>
				{/if}
			</li>
		{/each}
	</ul>
{/if}
