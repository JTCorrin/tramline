<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Card from '#lib/components/ui/card/index.js';
</script>

<svelte:head><title>Invite · Tramline</title></svelte:head>

<main class="mx-auto mt-24 w-full max-w-sm p-6">
	<Card.Root>
		<Card.Header>
			<Card.Title>This invite can't be used</Card.Title>
			<Card.Description>
				It has been used already, revoked, or has expired. Ask whoever sent it for a new one.
			</Card.Description>
		</Card.Header>
		<Card.Content class="text-sm">
			<a href={resolve('/(auth)/sign-in')}>Sign in</a>
		</Card.Content>
	</Card.Root>
</main>
