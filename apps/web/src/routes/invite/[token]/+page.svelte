<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Invite · Tramline</title></svelte:head>

<main class="mx-auto mt-24 w-full max-w-sm p-6">
	<Card.Root>
		{#if data.valid && !form?.error}
			<Card.Header>
				<Card.Title>Join {data.organization}</Card.Title>
				<Card.Description>
					You've been invited to join {data.organization} as {data.role === 'admin'
						? 'an admin'
						: 'a member'}. Only accept if you expected this invite.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form method="POST">
					<Button type="submit" class="w-full">Join {data.organization}</Button>
				</form>
			</Card.Content>
		{:else}
			<Card.Header>
				<Card.Title>This invite can't be used</Card.Title>
				<Card.Description>
					It has been used already, revoked, or has expired. Ask whoever sent it for a new one.
				</Card.Description>
			</Card.Header>
			<Card.Content class="text-sm">
				<a href={resolve('/(auth)/sign-in')}>Sign in</a>
			</Card.Content>
		{/if}
	</Card.Root>
</main>
