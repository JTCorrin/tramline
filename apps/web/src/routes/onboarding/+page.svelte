<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { authClient } from '#lib/auth-client.js';
	import Logo from '#lib/components/logo.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { slugify } from '#lib/forms.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let name = $state('');
	let error = $state('');
	let pending = $state(false);
	const slug = $derived(slugify(name));

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		pending = true;
		error = '';
		const created = await authClient.organization.create({ name, slug });
		if (created.error) {
			error = created.error.message ?? 'Could not create the organization';
			pending = false;
			return;
		}
		await authClient.organization.setActive({ organizationId: created.data.id });
		await goto(resolve('/(app)'), { invalidateAll: true });
	}
</script>

<svelte:head><title>Create an organization · Tramline</title></svelte:head>

<main class="flex min-h-svh flex-col items-center justify-center gap-8 p-6">
	<Logo class="text-lg" withWordmark />
	<Card.Root class="w-full max-w-sm">
		<Card.Header>
			<Card.Title>Welcome, {data.userName}</Card.Title>
			<Card.Description>
				Projects live in an organization. Create one for yourself or your team.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<form onsubmit={submit}>
				<Field.Group>
					<Field.Field>
						<Field.Label for="org-name">Organization name</Field.Label>
						<Input id="org-name" placeholder="Acme Inc" required bind:value={name} />
						<Field.Description>URL: <code>{slug || 'acme-inc'}</code></Field.Description>
						{#if error}<Field.Error>{error}</Field.Error>{/if}
					</Field.Field>
					<Button type="submit" class="w-full" disabled={pending || !slug}>
						Create organization
					</Button>
				</Field.Group>
			</form>
		</Card.Content>
	</Card.Root>
</main>
