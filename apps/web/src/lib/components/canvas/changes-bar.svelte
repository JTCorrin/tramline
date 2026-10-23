<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { reportError } from '#lib/forms.js';
	import type { Workspace } from '#lib/resources/workspace.svelte.js';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import { toast } from 'svelte-sonner';

	let { workspace, panelOpen = false }: { workspace: Workspace; panelOpen?: boolean } = $props();

	const count = $derived(workspace.changes.count);

	async function deploy() {
		try {
			await workspace.deploy();
			toast.success(`Deploying to ${workspace.environment.name}`);
		} catch (error) {
			reportError(error);
		}
	}
</script>

{#if count > 0}
	<div
		class="absolute top-4 z-30 flex -translate-x-1/2 items-center gap-1 rounded-lg border bg-popover p-1 pl-3 text-sm shadow-lg"
		style:left={panelOpen ? 'calc((100% - min(100%, 36rem)) / 2)' : '50%'}
		data-testid="changes-bar"
	>
		<span class="mr-1 size-2 rounded-full bg-amber-400"></span>
		<span class="mr-2">
			Apply {count}
			{count === 1 ? 'change' : 'changes'}
		</span>
		<Popover.Root>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button variant="ghost" size="sm" {...props}>Details</Button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content class="w-96 p-0" align="center">
				<div class="max-h-96 divide-y overflow-auto">
					{#each workspace.changes.changes as change (change.serviceId ?? 'shared')}
						<div class="p-3">
							<div class="text-sm font-medium">{change.label}</div>
							<ul class="mt-1 space-y-0.5 font-mono text-xs text-muted-foreground">
								{#each change.details as line, i (i)}<li>{line}</li>{/each}
							</ul>
						</div>
					{/each}
				</div>
			</Popover.Content>
		</Popover.Root>
		<Button
			variant="ghost"
			size="sm"
			onclick={() => workspace.discard().catch(reportError)}
			disabled={workspace.deploying}
		>
			Discard
		</Button>
		<Button size="sm" onclick={deploy} disabled={workspace.deploying}>
			<RocketIcon /> Deploy
		</Button>
	</div>
{/if}
