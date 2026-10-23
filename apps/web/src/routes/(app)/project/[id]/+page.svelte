<script lang="ts">
	import ProjectView from '#lib/components/project/project-view.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>{data.project.name} · Tramline</title></svelte:head>

{#key data.project.id}
	<ProjectView {data} />
{/key}
