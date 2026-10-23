<script lang="ts">
	import '@xyflow/svelte/dist/style.css';
	import * as ContextMenu from '#lib/components/ui/context-menu/index.js';
	import type { Workspace } from '#lib/resources/workspace.svelte.js';
	import BoxIcon from '@lucide/svelte/icons/box';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import PanelRightOpenIcon from '@lucide/svelte/icons/panel-right-open';
	import SquareDashedIcon from '@lucide/svelte/icons/square-dashed';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import type { Position } from '@tramline/contracts';
	import {
		Background,
		BackgroundVariant,
		Controls,
		MiniMap,
		SvelteFlow,
		useSvelteFlow,
		type Edge
	} from '@xyflow/svelte';
	import { mode } from 'mode-watcher';
	import { DATABASES, type AddServiceAction } from './add-service';
	import ServiceNode, { type ServiceNodeType } from './service-node.svelte';

	let {
		workspace,
		selectedId,
		onselect,
		onadd,
		ondelete,
		onmove
	}: {
		workspace: Workspace;
		selectedId: string | null;
		onselect: (serviceId: string | null) => void;
		onadd: (action: AddServiceAction, position: Position) => void;
		ondelete: (serviceId: string) => void;
		onmove: (moves: { id: string; position: Position }[]) => void;
	} = $props();

	const flow = useSvelteFlow();
	const nodeTypes = { service: ServiceNode };

	let nodes = $state.raw<ServiceNodeType[]>([]);
	let edges = $state.raw<Edge[]>([]);

	$effect(() => {
		nodes = workspace.canvas.services.map((service) => ({
			id: service.id,
			type: 'service',
			position: service.position,
			data: { service },
			selected: service.id === selectedId
		}));
		edges = workspace.canvas.edges.map((edge) => ({
			...edge,
			animated: true,
			class: 'tramline-edge'
		}));
	});

	// where the context menu was opened, in canvas coordinates, and on which service (if any)
	let menuPosition: Position = { x: 0, y: 0 };
	let menuService = $state<string | null>(null);

	/** Centre of the visible canvas, used when adding from the command palette. */
	export function center(): Position {
		const box = document.querySelector('.svelte-flow')?.getBoundingClientRect();
		if (!box) return { x: 0, y: 0 };
		const point = flow.screenToFlowPosition({
			x: box.x + box.width / 2,
			y: box.y + box.height / 2
		});
		return { x: point.x - 128, y: point.y - 50 };
	}

	const add = (action: AddServiceAction) => onadd(action, menuPosition);
</script>

<ContextMenu.Root>
	<ContextMenu.Trigger
		class="absolute inset-0"
		oncontextmenu={(event) => {
			const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
			menuPosition = { x: point.x - 128, y: point.y - 40 };
		}}
	>
		<SvelteFlow
			bind:nodes
			bind:edges
			{nodeTypes}
			colorMode={mode.current ?? 'dark'}
			fitView
			fitViewOptions={{ maxZoom: 1, padding: 0.3 }}
			minZoom={0.2}
			deleteKey={null}
			nodesConnectable={false}
			onnodeclick={({ node }) => onselect(node.id)}
			onpaneclick={() => onselect(null)}
			onnodecontextmenu={({ node }) => (menuService = node.id)}
			onpanecontextmenu={() => (menuService = null)}
			onnodedragstop={({ nodes: moved }) =>
				onmove(moved.map((node) => ({ id: node.id, position: node.position })))}
		>
			<Background variant={BackgroundVariant.Dots} gap={20} />
			<Controls showLock={false} />
			<MiniMap pannable zoomable class="hidden md:block" />
		</SvelteFlow>
	</ContextMenu.Trigger>
	<ContextMenu.Content class="w-56">
		{#if menuService}
			{@const service = menuService}
			<ContextMenu.Item onSelect={() => onselect(service)}>
				<PanelRightOpenIcon /> Open service
			</ContextMenu.Item>
			<ContextMenu.Separator />
			<ContextMenu.Item variant="destructive" onSelect={() => ondelete(service)}>
				<TrashIcon /> Delete service
			</ContextMenu.Item>
		{:else}
			<ContextMenu.Label>Add to project</ContextMenu.Label>
			<ContextMenu.Item onSelect={() => add({ kind: 'repo' })}>
				<GitBranchIcon /> GitHub Repo
			</ContextMenu.Item>
			<ContextMenu.Item onSelect={() => add({ kind: 'image' })}>
				<BoxIcon /> Docker Image
			</ContextMenu.Item>
			<ContextMenu.Sub>
				<ContextMenu.SubTrigger><DatabaseIcon /> Database</ContextMenu.SubTrigger>
				<ContextMenu.SubContent class="w-44">
					{#each DATABASES as db (db.engine)}
						<ContextMenu.Item onSelect={() => add({ kind: 'database', engine: db.engine })}>
							{db.label}
						</ContextMenu.Item>
					{/each}
				</ContextMenu.SubContent>
			</ContextMenu.Sub>
			<ContextMenu.Item onSelect={() => add({ kind: 'empty' })}>
				<SquareDashedIcon /> Empty Service
			</ContextMenu.Item>
		{/if}
	</ContextMenu.Content>
</ContextMenu.Root>

{#if workspace.canvas.services.length === 0}
	<div class="pointer-events-none absolute inset-0 flex items-center justify-center">
		<div class="rounded-lg border bg-background/80 px-4 py-3 text-center text-sm backdrop-blur">
			<div class="font-medium">This project is empty</div>
			<div class="text-muted-foreground">
				Right-click anywhere, or press <kbd class="rounded border px-1 font-mono text-xs">⌘K</kbd>,
				to add a service
			</div>
		</div>
	</div>
{/if}

<style>
	:global(.tramline-edge .svelte-flow__edge-path) {
		stroke: var(--color-muted-foreground);
		stroke-width: 1.5;
		stroke-dasharray: 5 5;
	}
	:global(.svelte-flow) {
		--xy-background-color: var(--color-background);
		--xy-node-border-radius: 0.75rem;
	}
	:global(.svelte-flow .svelte-flow__node-service) {
		padding: 0;
		border: 0;
		background: transparent;
		box-shadow: none;
	}
</style>
