<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { reportError } from '#lib/forms.js';
	import type { Project } from '@tramline/contracts';

	type Values = { name: string; description: string };

	let {
		open = $bindable(false),
		project,
		onsubmit
	}: {
		open?: boolean;
		/** When set, the dialog edits this project instead of creating one. */
		project?: Project;
		onsubmit: (values: Values) => Promise<unknown>;
	} = $props();

	let name = $state('');
	let description = $state('');
	let pending = $state(false);

	$effect(() => {
		if (open) {
			name = project?.name ?? '';
			description = project?.description ?? '';
		}
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		pending = true;
		try {
			await onsubmit({ name, description });
			open = false;
		} catch (error) {
			reportError(error);
		} finally {
			pending = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<form onsubmit={submit}>
			<Dialog.Header>
				<Dialog.Title>{project ? 'Project settings' : 'New project'}</Dialog.Title>
				<Dialog.Description>
					{project
						? 'Rename the project or change its description.'
						: 'A project is a canvas of services that are deployed together.'}
				</Dialog.Description>
			</Dialog.Header>
			<Field.Group class="py-4">
				<Field.Field>
					<Field.Label for="project-name">Name</Field.Label>
					<Input id="project-name" required maxlength={64} bind:value={name} />
				</Field.Field>
				<Field.Field>
					<Field.Label for="project-description">Description</Field.Label>
					<Textarea
						id="project-description"
						maxlength={280}
						placeholder="Optional"
						bind:value={description}
					/>
				</Field.Field>
			</Field.Group>
			<Dialog.Footer>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" {...props}>Cancel</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={pending || !name.trim()}>
					{project ? 'Save' : 'Create project'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
