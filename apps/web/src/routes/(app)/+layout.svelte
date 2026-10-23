<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Logo from '#lib/components/logo.svelte';
	import OrgSwitcher from '#lib/components/shell/org-switcher.svelte';
	import ProjectSwitcher from '#lib/components/shell/project-switcher.svelte';
	import type { Project } from '@tramline/contracts';
	import UserMenu from '#lib/components/shell/user-menu.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	// set by project pages; drives the project breadcrumb
	const project = $derived(page.data.project as Project | undefined);
</script>

<div class="flex min-h-svh flex-col">
	<header class="flex h-14 shrink-0 items-center gap-2 border-b px-4">
		<a href={resolve('/(app)')} aria-label="Dashboard"><Logo /></a>
		<span class="text-muted-foreground/50">/</span>
		<OrgSwitcher organizations={data.organizations} active={data.activeOrganization} />
		{#if project}
			<span class="text-muted-foreground/50">/</span>
			<ProjectSwitcher active={project} />
		{/if}
		<div class="ml-auto">
			<UserMenu user={data.user} />
		</div>
	</header>
	{@render children()}
</div>
