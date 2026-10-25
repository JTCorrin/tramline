<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { authClient } from '#lib/auth-client.js';
	import { hydrated } from '#lib/hydrated.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';

	let code = $state('');
	let backup = $state(false);
	let error = $state('');
	let pending = $state(false);
	const ready = hydrated();

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		pending = true;
		error = '';
		const result = backup
			? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
			: await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, '') });
		pending = false;
		if (result.error) {
			error = result.error.message ?? 'That code is not right';
			return;
		}
		await goto(resolve('/(app)'), { invalidateAll: true });
	}
</script>

<svelte:head><title>Two-factor authentication · Tramline</title></svelte:head>

<Card.Root>
	<Card.Header>
		<Card.Title>Two-factor authentication</Card.Title>
		<Card.Description>
			{backup
				? 'Enter one of the backup codes you saved when you turned this on.'
				: 'Enter the 6-digit code from your authenticator app.'}
		</Card.Description>
	</Card.Header>
	<Card.Content>
		<form onsubmit={submit}>
			<Field.Group>
				<Field.Field>
					<Field.Label for="code">{backup ? 'Backup code' : 'Code'}</Field.Label>
					<Input
						id="code"
						autocomplete="one-time-code"
						inputmode={backup ? 'text' : 'numeric'}
						required
						bind:value={code}
					/>
					{#if error}<Field.Error>{error}</Field.Error>{/if}
				</Field.Field>
				<Button type="submit" class="w-full" disabled={!ready.current || pending}>Verify</Button>
				<Button
					type="button"
					variant="ghost"
					class="w-full"
					onclick={() => {
						backup = !backup;
						code = '';
						error = '';
					}}>{backup ? 'Use your authenticator app' : 'Use a backup code'}</Button
				>
			</Field.Group>
		</form>
	</Card.Content>
</Card.Root>
