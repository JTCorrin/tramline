<script lang="ts">
	import { api } from '#lib/api.js';
	import { Button, buttonVariants } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import { reportError } from '#lib/forms.js';
	import type { Workspace } from '#lib/resources/workspace.svelte.js';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import PlusIcon from '@lucide/svelte/icons/plus';

	let { workspace }: { workspace: Workspace } = $props();

	let creating = $state(false);
	let name = $state('');
	/** An environment to duplicate, or '' to start fresh. */
	let copyFrom = $state('');
	const copied = $derived(workspace.environments.find((env) => env.id === copyFrom));

	async function create(event: SubmitEvent) {
		event.preventDefault();
		try {
			const env = await api().environments.create({
				projectId: workspace.project.id,
				name,
				copyFrom: copyFrom || undefined
			});
			await workspace.refreshEnvironments();
			await workspace.selectEnvironment(env.id);
			creating = false;
			name = '';
			copyFrom = '';
		} catch (error) {
			reportError(error);
		}
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class={buttonVariants({ variant: 'outline', size: 'sm' })}
		data-testid="environment-switcher"
	>
		<LayersIcon class="text-muted-foreground" />
		{workspace.environment.name}
		<ChevronsUpDownIcon class="text-muted-foreground" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" class="w-56">
		<DropdownMenu.Label>Environments</DropdownMenu.Label>
		{#each workspace.environments as env (env.id)}
			<DropdownMenu.Item onSelect={() => workspace.selectEnvironment(env.id)}>
				{env.name}
				{#if env.id === workspace.environmentId}<CheckIcon class="ml-auto" />{/if}
			</DropdownMenu.Item>
		{/each}
		<DropdownMenu.Separator />
		<DropdownMenu.Item onSelect={() => (creating = true)}>
			<PlusIcon /> New environment
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>

<Dialog.Root bind:open={creating}>
	<Dialog.Content class="sm:max-w-sm">
		<form onsubmit={create}>
			<Dialog.Header>
				<Dialog.Title>New environment</Dialog.Title>
				<Dialog.Description>
					{#if copied}
						A copy of {copied.name}: every service with its config and variables. Databases get new
						credentials and start empty; domains and volumes are not copied.
					{:else}
						Starts with every service, configured like {workspace.environments[0]?.name}. Variables
						are not copied, but databases get their own credentials.
					{/if}
				</Dialog.Description>
			</Dialog.Header>
			<Field.Group class="py-4">
				<Field.Field>
					<Field.Label for="env-name">Name</Field.Label>
					<Input id="env-name" placeholder="staging" required bind:value={name} />
				</Field.Field>
				<Field.Field>
					<Field.Label>Start from</Field.Label>
					<Select.Root type="single" bind:value={copyFrom}>
						<Select.Trigger class="w-full" aria-label="Start from">
							{copied ? `A copy of ${copied.name}` : 'Fresh'}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="">Fresh</Select.Item>
							{#each workspace.environments as env (env.id)}
								<Select.Item value={env.id}>A copy of {env.name}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</Field.Field>
			</Field.Group>
			<Dialog.Footer><Button type="submit">Create environment</Button></Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
