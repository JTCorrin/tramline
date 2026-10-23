<script lang="ts">
	import { api } from '#lib/api.js';
	import ServiceIcon from '#lib/components/canvas/service-icon.svelte';
	import StatusBadge from '#lib/components/canvas/status-badge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { reportError } from '#lib/forms.js';
	import type { Workspace } from '#lib/resources/workspace.svelte.js';
	import XIcon from '@lucide/svelte/icons/x';
	import type { CanvasService, ServiceConfigPatch, ServiceConfigView } from '@tramline/contracts';
	import { toast } from 'svelte-sonner';
	import DeploymentsList from './deployments-list.svelte';
	import ServiceSettings from './service-settings.svelte';
	import VariablesEditor from './variables-editor.svelte';

	let {
		workspace,
		service,
		onclose
	}: { workspace: Workspace; service: CanvasService; onclose: () => void } = $props();

	const client = api();
	let tab = $state('deployments');
	let view = $state<ServiceConfigView>();
	let suggestions = $state<string[]>([]);

	$effect(() => {
		void workspace.version;
		const { id } = service;
		client.services
			.config(id, workspace.environmentId)
			.then((v) => {
				if (id === service.id) view = v;
			})
			.catch(reportError);
	});

	$effect(() => {
		void workspace.version;
		workspace.referenceSuggestions(service.id).then((s) => (suggestions = s), reportError);
	});

	async function stage(patch: ServiceConfigPatch) {
		try {
			view = await client.services.stageConfig(service.id, workspace.environmentId, patch);
		} catch (error) {
			reportError(error);
		}
	}

	async function rename(name: string) {
		try {
			await client.services.update(service.id, { name });
			toast.success(`Renamed to ${name}`);
		} catch (error) {
			reportError(error);
		}
	}

	async function remove() {
		try {
			await client.services.remove(service.id);
			onclose();
			toast.success(`Deleted ${service.name}`);
		} catch (error) {
			reportError(error);
		}
	}
</script>

<aside
	class="absolute inset-y-0 right-0 z-20 flex w-full max-w-xl flex-col border-l bg-background shadow-2xl"
	aria-label="{service.name} service"
	data-testid="service-panel"
>
	<header class="flex items-center gap-3 border-b px-4 py-3">
		<ServiceIcon kind={service.kind} icon={service.icon} />
		<div class="min-w-0 flex-1">
			<h2 class="truncate font-semibold">{service.name}</h2>
			<div class="flex items-center gap-3">
				<StatusBadge status={service.status} />
				{#if service.url}
					<a
						href={service.url}
						target="_blank"
						rel="external noreferrer"
						class="truncate text-xs text-muted-foreground underline-offset-2 hover:underline"
						data-testid="service-url"
					>
						{service.url}
					</a>
				{/if}
			</div>
		</div>
		<Button variant="ghost" size="icon-sm" aria-label="Close panel" onclick={onclose}>
			<XIcon />
		</Button>
	</header>

	<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col gap-0">
		<Tabs.List class="mx-4 mt-3">
			<Tabs.Trigger value="deployments">Deployments</Tabs.Trigger>
			<Tabs.Trigger value="variables">Variables</Tabs.Trigger>
			<Tabs.Trigger value="metrics">Metrics</Tabs.Trigger>
			<Tabs.Trigger value="settings">Settings</Tabs.Trigger>
		</Tabs.List>
		<div class="min-h-0 flex-1 overflow-y-auto">
			<Tabs.Content value="deployments" class="p-4">
				<DeploymentsList
					serviceId={service.id}
					environmentId={workspace.environmentId}
					version={workspace.version}
				/>
			</Tabs.Content>
			<Tabs.Content value="variables" class="p-4">
				<VariablesEditor
					environmentId={workspace.environmentId}
					serviceId={service.id}
					version={workspace.version}
					{suggestions}
				/>
			</Tabs.Content>
			<Tabs.Content value="metrics" class="p-4">
				<div class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
					CPU, memory and network charts appear once deployments run on a node.
				</div>
			</Tabs.Content>
			<Tabs.Content value="settings">
				{#if view}
					<ServiceSettings
						{service}
						environmentName={workspace.environment.name}
						{view}
						onstage={stage}
						onrename={rename}
						ondelete={remove}
					/>
				{/if}
			</Tabs.Content>
		</div>
	</Tabs.Root>
</aside>
