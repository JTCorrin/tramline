<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { reportError } from '#lib/forms.js';
	import type { ServiceSource } from '@tramline/contracts';

	let {
		kind = $bindable(),
		oncreate
	}: {
		/** Open while set. */
		kind: 'image' | 'repo' | undefined;
		oncreate: (source: ServiceSource) => Promise<unknown>;
	} = $props();

	let image = $state('');
	let repo = $state('');
	let branch = $state('main');
	let pending = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		pending = true;
		try {
			await oncreate(
				kind === 'image'
					? { type: 'image', image }
					: { type: 'repo', repo, branch, rootDirectory: '/' }
			);
			kind = undefined;
			image = repo = '';
			branch = 'main';
		} catch (error) {
			reportError(error);
		} finally {
			pending = false;
		}
	}
</script>

<Dialog.Root bind:open={() => kind !== undefined, (open) => !open && (kind = undefined)}>
	<Dialog.Content class="sm:max-w-md">
		<form onsubmit={submit}>
			<Dialog.Header>
				<Dialog.Title
					>{kind === 'image' ? 'Deploy a Docker image' : 'Deploy a Git repository'}</Dialog.Title
				>
				<Dialog.Description>
					{kind === 'image'
						? 'Any public image, e.g. nginx, ghcr.io/org/app:1.2'
						: 'Builds with Railpack, or your Dockerfile when the repository has one.'}
				</Dialog.Description>
			</Dialog.Header>
			<Field.Group class="py-4">
				{#if kind === 'image'}
					<Field.Field>
						<Field.Label for="new-source-image">Image</Field.Label>
						<Input id="new-source-image" placeholder="traefik/whoami" required bind:value={image} />
					</Field.Field>
				{:else}
					<Field.Field>
						<Field.Label for="new-source-repo">Repository</Field.Label>
						<Input
							id="new-source-repo"
							placeholder="https://github.com/acme/api"
							required
							bind:value={repo}
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="new-source-branch">Branch</Field.Label>
						<Input id="new-source-branch" required bind:value={branch} />
					</Field.Field>
				{/if}
			</Field.Group>
			<Dialog.Footer>
				<Button type="submit" disabled={pending}>Add service</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
