<script lang="ts">
	import { api } from '#lib/api.js';
	import type { AddServiceAction } from '#lib/components/canvas/add-service.js';
	import ChangesBar from '#lib/components/canvas/changes-bar.svelte';
	import CommandPalette from '#lib/components/canvas/command-palette.svelte';
	import EnvironmentSwitcher from '#lib/components/canvas/environment-switcher.svelte';
	import NodeStatus from '#lib/components/canvas/node-status.svelte';
	import ProjectCanvas from '#lib/components/canvas/project-canvas.svelte';
	import SourceDialog from '#lib/components/canvas/source-dialog.svelte';
	import ServicePanel from '#lib/components/service/service-panel.svelte';
	import VariablesEditor from '#lib/components/service/variables-editor.svelte';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { reportError } from '#lib/forms.js';
	import { Workspace, type WorkspaceInit } from '#lib/resources/workspace.svelte.js';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import VariableIcon from '@lucide/svelte/icons/variable';
	import type { CreateService, Position } from '@tramline/contracts';
	import { SvelteFlowProvider } from '@xyflow/svelte';
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';

	let { data }: { data: WorkspaceInit } = $props();

	// one workspace per mounted project; the page re-mounts this component when the project changes
	const workspace = untrack(() => new Workspace(data));
	const client = api();

	$effect(() => workspace.connect());

	const selected = $derived(workspace.selectedService);

	let canvas = $state<ReturnType<typeof ProjectCanvas>>();
	let paletteOpen = $state(false);
	let sharedOpen = $state(false);
	let sharedSuggestions = $state<string[]>([]);
	let sourceKind = $state<'image' | 'repo'>();
	let sourcePosition: Position = { x: 0, y: 0 };
	let deleting = $state<string | null>(null);

	const select = (serviceId: string | null) => workspace.selectService(serviceId);

	async function create(input: Omit<CreateService, 'projectId'>) {
		const service = await client.services.create({ projectId: workspace.project.id, ...input });
		await workspace.refresh();
		select(service.id);
		toast.success(`Added ${service.name}. Deploy to start it.`);
	}

	/** Moves `position` right until it doesn't overlap an existing node (nodes are 256×~110). */
	function freeSpot(position: Position): Position {
		const taken = (p: Position) =>
			workspace.canvas.services.some(
				(s) => Math.abs(s.position.x - p.x) < 280 && Math.abs(s.position.y - p.y) < 130
			);
		const spot = { ...position };
		while (taken(spot)) spot.x += 300;
		return spot;
	}

	function add(action: AddServiceAction, at: Position) {
		const position = freeSpot(at);
		if (action.kind === 'image' || action.kind === 'repo') {
			sourcePosition = position;
			sourceKind = action.kind;
			return;
		}
		create({
			kind: action.kind,
			engine: action.kind === 'database' ? action.engine : undefined,
			position
		}).catch(reportError);
	}

	async function move(moves: { id: string; position: Position }[]) {
		try {
			await Promise.all(moves.map((m) => client.services.update(m.id, { position: m.position })));
		} catch (error) {
			reportError(error);
		}
	}

	async function remove(serviceId: string) {
		try {
			await client.services.remove(serviceId);
			if (workspace.selectedServiceId === serviceId) select(null);
			await workspace.refresh();
		} catch (error) {
			reportError(error);
		}
	}

	$effect(() => {
		if (!sharedOpen) return;
		void workspace.version;
		workspace.referenceSuggestions(null).then((s) => (sharedSuggestions = s), reportError);
	});

	const deletingService = $derived(workspace.canvas.services.find((s) => s.id === deleting));
</script>

<SvelteFlowProvider>
	<div class="flex flex-1 flex-col">
		<div class="flex h-12 shrink-0 items-center gap-2 border-b px-4">
			<EnvironmentSwitcher {workspace} />
			<div class="ml-auto flex items-center gap-2">
				<NodeStatus version={workspace.version} />
				<Button variant="ghost" size="sm" onclick={() => (sharedOpen = true)}>
					<VariableIcon /> Shared variables
				</Button>
				<Button variant="outline" size="sm" onclick={() => (paletteOpen = true)}>
					<PlusIcon /> Add
					<kbd class="ml-1 font-mono text-[10px] text-muted-foreground">⌘K</kbd>
				</Button>
			</div>
		</div>
		<div class="relative flex-1 overflow-hidden">
			<ProjectCanvas
				bind:this={canvas}
				{workspace}
				selectedId={selected?.id ?? null}
				onselect={select}
				onadd={add}
				onmove={move}
				ondelete={(id) => (deleting = id)}
			/>
			<ChangesBar {workspace} panelOpen={selected !== undefined} />
			{#if selected}
				{#key selected.id}
					<ServicePanel {workspace} service={selected} onclose={() => select(null)} />
				{/key}
			{/if}
		</div>
	</div>
</SvelteFlowProvider>

<CommandPalette
	bind:open={paletteOpen}
	{workspace}
	onadd={(action) => add(action, canvas?.center() ?? { x: 0, y: 0 })}
	onselect={select}
/>

<SourceDialog
	bind:kind={sourceKind}
	oncreate={(source) => create({ kind: source.type, source, position: sourcePosition })}
/>

<Sheet.Root bind:open={sharedOpen}>
	<Sheet.Content class="w-full sm:max-w-xl">
		<Sheet.Header>
			<Sheet.Title>Shared variables · {workspace.environment.name}</Sheet.Title>
			<Sheet.Description>
				Available to every service as <code class="font-mono"
					>&#36;&#123;&#123;shared.KEY&#125;&#125;</code
				>.
			</Sheet.Description>
		</Sheet.Header>
		<div class="overflow-y-auto px-4 pb-4">
			<VariablesEditor
				track={(request) => workspace.track(request)}
				environmentId={workspace.environmentId}
				serviceId={null}
				version={workspace.version}
				suggestions={sharedSuggestions}
			/>
		</div>
	</Sheet.Content>
</Sheet.Root>

<AlertDialog.Root bind:open={() => deleting !== null, (open) => !open && (deleting = null)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete {deletingService?.name}?</AlertDialog.Title>
			<AlertDialog.Description>
				This removes it from every environment immediately. It cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				variant="destructive"
				onclick={() => {
					const id = deleting!;
					deleting = null;
					remove(id);
				}}
			>
				Delete service
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
