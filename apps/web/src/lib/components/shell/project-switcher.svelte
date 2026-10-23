<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { api } from '#lib/api.js';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { reportError } from '#lib/forms.js';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import LayoutGridIcon from '@lucide/svelte/icons/layout-grid';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import type { Project } from '@tramline/contracts';

	let { active }: { active: Pick<Project, 'id' | 'name'> } = $props();

	let projects = $state<Project[]>();

	// fetched when the menu opens so the list reflects projects created elsewhere
	async function load(open: boolean) {
		if (!open) return;
		try {
			projects = await api().projects.getAll();
		} catch (error) {
			reportError(error);
		}
	}
</script>

<DropdownMenu.Root onOpenChange={load}>
	<DropdownMenu.Trigger class={buttonVariants({ variant: 'ghost', size: 'sm' })}>
		{active.name}
		<ChevronsUpDownIcon class="text-muted-foreground" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" class="w-60">
		<DropdownMenu.Group>
			<DropdownMenu.Label>Projects</DropdownMenu.Label>
			{#if projects === undefined}
				<DropdownMenu.Item disabled>Loading…</DropdownMenu.Item>
			{:else}
				{#each projects as project (project.id)}
					<DropdownMenu.Item
						onSelect={() => goto(resolve('/(app)/project/[id]', { id: project.id }))}
					>
						<span class="truncate">{project.name}</span>
						{#if project.id === active.id}<CheckIcon class="ml-auto" />{/if}
					</DropdownMenu.Item>
				{/each}
			{/if}
		</DropdownMenu.Group>
		<DropdownMenu.Separator />
		<DropdownMenu.Item onSelect={() => goto(resolve('/(app)'))}>
			<LayoutGridIcon /> All projects
		</DropdownMenu.Item>
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route plus a query flag -->
		<DropdownMenu.Item onSelect={() => goto(`${resolve('/(app)')}?new`)}>
			<PlusIcon /> New project
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
