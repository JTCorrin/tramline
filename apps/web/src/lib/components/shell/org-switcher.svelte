<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto, invalidateAll } from '$app/navigation';
	import { authClient } from '#lib/auth-client.js';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { reportError } from '#lib/forms.js';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import PlusIcon from '@lucide/svelte/icons/plus';

	type Org = { id: string; name: string };

	let { organizations, active }: { organizations: Org[]; active: Org } = $props();

	async function select(org: Org) {
		if (org.id === active.id) return;
		const { error } = await authClient.organization.setActive({ organizationId: org.id });
		if (error) return reportError(error);
		await goto(resolve('/(app)'));
		await invalidateAll();
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger class={buttonVariants({ variant: 'ghost', size: 'sm' })}>
		{active.name}
		<ChevronsUpDownIcon class="text-muted-foreground" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" class="w-56">
		<DropdownMenu.Group>
			<DropdownMenu.Label>Organizations</DropdownMenu.Label>
			{#each organizations as org (org.id)}
				<DropdownMenu.Item onSelect={() => select(org)}>
					{org.name}
					{#if org.id === active.id}<CheckIcon class="ml-auto" />{/if}
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Group>
		<DropdownMenu.Separator />
		<DropdownMenu.Item onSelect={() => goto(resolve('/onboarding'))}>
			<PlusIcon /> New organization
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
