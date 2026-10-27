<script lang="ts">
	import { hydrated } from '#lib/hydrated.svelte.js';
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

	let name = $state('');
	let email = $state('');
	let password = $state('');
	let error = $state('');
	let pending = $state(false);
	const ready = hydrated();

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		pending = true;
		error = '';
		const result = await authClient.signUp.email({ name, email, password });
		pending = false;
		if (result.error) {
			error = result.error.message ?? 'Could not create your account';
			return;
		}
		// the dashboard sends anyone without an organization to onboarding; an invitee has one
		await goto(resolve('/(app)'), { invalidateAll: true });
	}
</script>

<svelte:head><title>Create account · Tramline</title></svelte:head>

<Card.Root>
	<Card.Header>
		<Card.Title>Create your account</Card.Title>
		<Card.Description>Deploy anything, anywhere you choose.</Card.Description>
	</Card.Header>
	<Card.Content>
		<form onsubmit={submit}>
			<Field.Group>
				{#if data.githubAuthEnabled}
					<GithubButton />
					<Field.Separator>or</Field.Separator>
				{/if}
				<Field.Field>
					<Field.Label for="name">Name</Field.Label>
					<Input id="name" autocomplete="name" required bind:value={name} />
				</Field.Field>
				<Field.Field>
					<Field.Label for="email">Email</Field.Label>
					<Input id="email" type="email" autocomplete="email" required bind:value={email} />
				</Field.Field>
				<Field.Field>
					<Field.Label for="password">Password</Field.Label>
					<Input
						id="password"
						type="password"
						autocomplete="new-password"
						minlength={8}
						required
						bind:value={password}
					/>
					<Field.Description>At least 8 characters.</Field.Description>
					{#if error}<Field.Error>{error}</Field.Error>{/if}
				</Field.Field>
				<Button type="submit" class="w-full" disabled={!ready.current || pending}
					>Create account</Button
				>
				<Field.Description class="text-center">
					Already have an account? <a href={resolve('/(auth)/sign-in')}>Sign in</a>
				</Field.Description>
			</Field.Group>
		</form>
	</Card.Content>
</Card.Root>
