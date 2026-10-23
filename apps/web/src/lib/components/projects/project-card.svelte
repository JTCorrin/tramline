<script lang="ts">
	import { resolve } from '$app/paths';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import type { Project } from '@tramline/contracts';

	let {
		project,
		onedit,
		ondelete
	}: { project: Project; onedit: () => void; ondelete: () => void } = $props();

	const updated = $derived(
		new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(project.updatedAt))
	);
</script>

<Card.Root class="relative transition-colors hover:border-foreground/30" data-testid="project-card">
	<Card.Header>
		<Card.Title>
			<a
				href={resolve('/(app)/project/[id]', { id: project.id })}
				class="after:absolute after:inset-0">{project.name}</a
			>
		</Card.Title>
		<Card.Description class="line-clamp-2 min-h-10">
			{project.description || 'No description'}
		</Card.Description>
		<Card.Action class="relative z-10">
			<DropdownMenu.Root>
				<DropdownMenu.Trigger
					class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
					aria-label="Project actions"
				>
					<EllipsisIcon />
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end">
					<DropdownMenu.Item onSelect={onedit}><PencilIcon /> Settings</DropdownMenu.Item>
					<DropdownMenu.Item variant="destructive" onSelect={ondelete}>
						<TrashIcon /> Delete
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</Card.Action>
	</Card.Header>
	<Card.Footer class="text-xs text-muted-foreground">Updated {updated}</Card.Footer>
</Card.Root>
