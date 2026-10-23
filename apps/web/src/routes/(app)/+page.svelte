<script lang="ts">
	import ProjectCard from '#lib/components/projects/project-card.svelte';
	import ProjectDialog from '#lib/components/projects/project-dialog.svelte';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { reportError } from '#lib/forms.js';
	import { projectCollection } from '#lib/resources/projects.svelte.js';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import type { Project } from '@tramline/contracts';
	import { toast } from 'svelte-sonner';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// re-seeded whenever load data changes, e.g. after switching organization
	const projects = $derived(projectCollection(data.projects));

	let creating = $state(false);
	let editing = $state<Project>();
	let deleting = $state<Project>();
</script>

<svelte:head><title>Projects · Tramline</title></svelte:head>

<main class="mx-auto w-full max-w-6xl p-6">
	<div class="mb-6 flex items-center justify-between">
		<h1 class="text-xl font-semibold tracking-tight">Projects</h1>
		<Button onclick={() => (creating = true)}><PlusIcon /> New project</Button>
	</div>

	{#if projects.items.length === 0}
		<div
			class="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-20 text-center"
		>
			<h2 class="font-medium">No projects yet</h2>
			<p class="max-w-sm text-sm text-muted-foreground">
				Create a project, then add services, databases and volumes on its canvas.
			</p>
			<Button variant="outline" onclick={() => (creating = true)}>
				<PlusIcon /> Create your first project
			</Button>
		</div>
	{:else}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each projects.items as project (project.id)}
				<ProjectCard
					{project}
					onedit={() => (editing = project)}
					ondelete={() => (deleting = project)}
				/>
			{/each}
		</div>
	{/if}
</main>

<ProjectDialog
	bind:open={creating}
	onsubmit={async (values) => {
		const project = await projects.create(values);
		toast.success(`Created ${project.name}`);
	}}
/>

<ProjectDialog
	bind:open={() => editing !== undefined, (open) => !open && (editing = undefined)}
	project={editing}
	onsubmit={(values) => projects.update(editing!.id, values)}
/>

<AlertDialog.Root
	bind:open={() => deleting !== undefined, (open) => !open && (deleting = undefined)}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete {deleting?.name}?</AlertDialog.Title>
			<AlertDialog.Description>
				This permanently deletes the project and everything in it. This cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				variant="destructive"
				onclick={() => {
					const target = deleting!;
					deleting = undefined;
					projects.remove(target.id).catch(reportError);
				}}
			>
				Delete project
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
