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

	let email = $state('');
	let password = $state('');
	let error = $state('');
	let pending = $state(false);
	const ready = hydrated();

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
		// accounts with two-factor authentication confirm a code next
		if (result.data && 'twoFactorRedirect' in result.data && result.data.twoFactorRedirect) {
			await goto(resolve('/(auth)/two-factor'));
			return;
		}
		await goto(resolve('/(app)'), { invalidateAll: true });
	}

	async function withPasskey() {
		error = '';
		const result = await authClient.signIn.passkey();
		if (result?.error) {
			error = result.error.message ?? 'Could not sign in with a passkey';
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
				<Button type="submit" class="w-full" disabled={!ready.current || pending}>Sign in</Button>
				<Button
					type="button"
					variant="outline"
					class="w-full"
					disabled={!ready.current}
					onclick={withPasskey}>Sign in with a passkey</Button
				>
				<Field.Description class="text-center">
					No account yet? <a href={resolve('/(auth)/sign-up')}>Create one</a>
				</Field.Description>
			</Field.Group>
		</form>
	</Card.Content>
</Card.Root>
