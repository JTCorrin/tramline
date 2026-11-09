<script lang="ts">
	import { api } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { timeAgo } from '#lib/format.js';
	import { reportError } from '#lib/forms.js';
	import type { SecurityEvent } from '@tramline/contracts';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import { toast } from 'svelte-sonner';

	/**
	 * What the service's containers tried that containment blocked, over the
	 * last week, by deployment, with a way to stop a deployment that's at it.
	 */
	let { serviceId, environmentId }: { serviceId: string; environmentId: string } = $props();

	const client = api();
	let events = $state<SecurityEvent[]>([]);
	let stopping = $state<string | null>(null);

	const load = () =>
		client.metrics
			.security(serviceId, environmentId)
			.then((list) => (events = list))
			.catch(reportError);

	$effect(() => {
		void load();
		const timer = setInterval(load, 30_000);
		return () => clearInterval(timer);
	});

	const WHAT: Record<SecurityEvent['kind'], string> = {
		metadata: 'the cloud metadata endpoint',
		private: 'private addresses: the LAN, the mesh or another environment',
		host: "the node's own ports",
		scan: 'connections fast enough to be a scan'
	};

	/** Per deployment and kind: how many, when last, and where. */
	const rows = $derived(
		[...Map.groupBy(events, (e) => `${e.deploymentId}:${e.kind}`).values()].map((group) => ({
			deploymentId: group[0]!.deploymentId,
			kind: group[0]!.kind,
			node: group[0]!.nodeName,
			count: group.reduce((sum, e) => sum + e.count, 0),
			last: group[0]!.at
		}))
	);

	async function stop(deploymentId: string) {
		if (!confirm('Stop this deployment? Its containers are removed, and nothing replaces them.'))
			return;
		stopping = deploymentId;
		try {
			await client.deployments.remove(deploymentId);
			toast.success('Stopping the deployment');
		} catch (error) {
			reportError(error);
		} finally {
			stopping = null;
		}
	}
</script>

<section class="space-y-2" data-testid="security-events">
	<h3 class="flex items-center gap-2 text-sm font-medium">
		<ShieldAlertIcon class="size-4" /> Blocked by containment
	</h3>
	{#if !rows.length}
		<p class="text-xs text-muted-foreground">
			Nothing in the last week. Its containers can't reach the cloud metadata endpoint, the LAN, the
			mesh, other environments or the node itself; attempts would show here.
		</p>
	{:else}
		<ul class="divide-y rounded-lg border text-sm">
			{#each rows as row (`${row.deploymentId}:${row.kind}`)}
				<li class="flex flex-wrap items-center gap-2 px-3 py-2" data-testid="security-event">
					<span class="font-medium">
						{row.kind === 'scan'
							? `${row.count.toLocaleString()} new connections in a minute or less`
							: `${row.count.toLocaleString()} blocked attempts`}
					</span>
					<span class="text-muted-foreground">to {WHAT[row.kind]}</span>
					<span class="w-full text-xs text-muted-foreground">
						Deployment <code>{row.deploymentId}</code>{row.node ? ` on ${row.node}` : ''} · last {timeAgo(
							row.last
						)}
					</span>
					<Button
						class="ml-auto"
						size="sm"
						variant="outline"
						disabled={stopping === row.deploymentId}
						onclick={() => stop(row.deploymentId)}>Stop deployment</Button
					>
				</li>
			{/each}
		</ul>
	{/if}
</section>
