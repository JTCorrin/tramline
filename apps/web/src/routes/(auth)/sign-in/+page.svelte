<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { authClient } from '#lib/auth-client.js';
	import GithubButton from '#lib/components/shell/github-button.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let email = $state('');
	let password = $state('');
	let error = $state('');
	let pending = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		pending = true;
		error = '';
		const result = await authClient.signIn.email({ email, password });
		pending = false;
		if (result.error) {
			error = result.error.message ?? 'Could not sign in';
			return;
		}
		await goto(resolve('/(app)'), { invalidateAll: true });
	}
</script>

<svelte:head><title>Sign in · Tramline</title></svelte:head>

<Card.Root>
	<Card.Header>
		<Card.Title>Sign in</Card.Title>
		<Card.Description>Welcome back to Tramline.</Card.Description>
	</Card.Header>
	<Card.Content>
		<form onsubmit={submit}>
			<Field.Group>
				{#if data.githubAuthEnabled}
					<GithubButton />
					<Field.Separator>or</Field.Separator>
				{/if}
				<Field.Field>
					<Field.Label for="email">Email</Field.Label>
					<Input id="email" type="email" autocomplete="email" required bind:value={email} />
				</Field.Field>
				<Field.Field>
					<Field.Label for="password">Password</Field.Label>
					<Input
						id="password"
						type="password"
						autocomplete="current-password"
						required
						bind:value={password}
					/>
					{#if error}<Field.Error>{error}</Field.Error>{/if}
				</Field.Field>
				<Button type="submit" class="w-full" disabled={pending}>Sign in</Button>
				<Field.Description class="text-center">
					No account yet? <a href={resolve('/(auth)/sign-up')}>Create one</a>
				</Field.Description>
			</Field.Group>
		</form>
	</Card.Content>
</Card.Root>
