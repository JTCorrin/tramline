<script lang="ts">
	import * as Command from '#lib/components/ui/command/index.js';
	import type { Workspace } from '#lib/resources/workspace.svelte.js';
	import BoxIcon from '@lucide/svelte/icons/box';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import SquareDashedIcon from '@lucide/svelte/icons/square-dashed';
	import { api } from '#lib/api.js';
	import TemplateIcon from '#lib/components/templates/template-icon.svelte';
	import LayoutTemplateIcon from '@lucide/svelte/icons/layout-template';
	import type { TemplateSummary } from '@tramline/contracts';
	import { DATABASES, type AddServiceAction } from './add-service';
	import ServiceIcon from './service-icon.svelte';

	let {
		open = $bindable(false),
		workspace,
		onadd,
		onselect
	}: {
		open?: boolean;
		workspace: Workspace;
		onadd: (action: AddServiceAction) => void;
		onselect: (serviceId: string) => void;
	} = $props();

	// the gallery's templates, listed here so one can be picked by name
	let templates = $state<TemplateSummary[]>([]);
	$effect(() => {
		if (!open || templates.length) return;
		api()
			.templates.list()
			.then(
				(list) => (templates = list),
				() => {}
			);
	});

	function run(fn: () => void) {
		open = false;
		// let the palette finish closing so a dialog opened by `fn` doesn't treat this click as outside it
		setTimeout(fn, 0);
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			open = !open;
		}
	}}
/>

<Command.Dialog bind:open title="Command palette" description="Add services or jump around">
	<Command.Input placeholder="Add a service, open a service, switch environment…" />
	<Command.List>
		<Command.Empty>No results.</Command.Empty>
		<Command.Group heading="Add">
			<Command.Item onSelect={() => run(() => onadd({ kind: 'repo' }))}>
				<GitBranchIcon /> GitHub Repo
			</Command.Item>
			<Command.Item onSelect={() => run(() => onadd({ kind: 'image' }))}>
				<BoxIcon /> Docker Image
			</Command.Item>
			{#each DATABASES as db (db.engine)}
				<Command.Item
					value="database {db.label}"
					onSelect={() => run(() => onadd({ kind: 'database', engine: db.engine }))}
				>
					<DatabaseIcon />
					{db.label}
				</Command.Item>
			{/each}
			<Command.Item onSelect={() => run(() => onadd({ kind: 'empty' }))}>
				<SquareDashedIcon /> Empty Service
			</Command.Item>
		</Command.Group>
		<Command.Separator />
		<Command.Group heading="Templates">
			{#each templates as t (t.id)}
				<Command.Item
					value="template {t.name} {t.tags.join(' ')}"
					onSelect={() => run(() => onadd({ kind: 'template', template: t.id }))}
				>
					<TemplateIcon icon={t.icon} class="size-5 rounded [&_svg]:size-3" />
					{t.name}
					<span class="ml-auto truncate text-xs text-muted-foreground">{t.tagline}</span>
				</Command.Item>
			{/each}
			<Command.Item
				value="template browse all templates"
				onSelect={() => run(() => onadd({ kind: 'template' }))}
			>
				<LayoutTemplateIcon /> Browse templates…
			</Command.Item>
		</Command.Group>
		{#if workspace.canvas.services.length}
			<Command.Separator />
			<Command.Group heading="Services">
				{#each workspace.canvas.services as service (service.id)}
					<Command.Item
						value="open {service.name}"
						onSelect={() => run(() => onselect(service.id))}
					>
						<ServiceIcon kind={service.kind} icon={service.icon} class="size-5 [&_svg]:size-3" />
						{service.name}
					</Command.Item>
				{/each}
			</Command.Group>
		{/if}
		{#if workspace.environments.length > 1}
			<Command.Separator />
			<Command.Group heading="Environments">
				{#each workspace.environments as env (env.id)}
					<Command.Item
						value="environment {env.name}"
						onSelect={() => run(() => workspace.selectEnvironment(env.id))}
					>
						<LayersIcon /> Switch to {env.name}
					</Command.Item>
				{/each}
			</Command.Group>
		{/if}
	</Command.List>
</Command.Dialog>
