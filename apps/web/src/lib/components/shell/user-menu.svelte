<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { authClient } from '#lib/auth-client.js';
	import * as Avatar from '#lib/components/ui/avatar/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import { mode, toggleMode } from 'mode-watcher';

	let { user }: { user: { name: string; email: string; image: string | null } } = $props();

	const initials = $derived(
		user.name
			.split(/\s+/)
			.map((part) => part[0])
			.join('')
			.slice(0, 2)
			.toUpperCase()
	);

	async function signOut() {
		await authClient.signOut();
		await goto(resolve('/(auth)/sign-in'), { invalidateAll: true });
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger class="rounded-full" aria-label="Account menu">
		<Avatar.Root class="size-8">
			{#if user.image}<Avatar.Image src={user.image} alt={user.name} />{/if}
			<Avatar.Fallback class="text-xs">{initials}</Avatar.Fallback>
		</Avatar.Root>
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-56">
		<DropdownMenu.Label class="font-normal">
			<div class="text-sm font-medium text-foreground">{user.name}</div>
			<div class="truncate text-xs text-muted-foreground">{user.email}</div>
		</DropdownMenu.Label>
		<DropdownMenu.Separator />
		<DropdownMenu.Item onSelect={toggleMode}>
			{#if mode.current === 'dark'}<SunIcon /> Light mode{:else}<MoonIcon /> Dark mode{/if}
		</DropdownMenu.Item>
		<DropdownMenu.Item onSelect={signOut}>
			<LogOutIcon /> Sign out
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
