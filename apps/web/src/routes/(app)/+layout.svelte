<script lang="ts">
	import { resolve } from '$app/paths';
	import Logo from '#lib/components/logo.svelte';
	import OrgSwitcher from '#lib/components/shell/org-switcher.svelte';
	import UserMenu from '#lib/components/shell/user-menu.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<div class="flex min-h-svh flex-col">
	<header class="flex h-14 shrink-0 items-center gap-2 border-b px-4">
		<a href={resolve('/(app)')} aria-label="Dashboard"><Logo /></a>
		<span class="text-muted-foreground/50">/</span>
		<OrgSwitcher organizations={data.organizations} active={data.activeOrganization} />
		<div class="ml-auto">
			<UserMenu user={data.user} />
		</div>
	</header>
	{@render children()}
</div>
