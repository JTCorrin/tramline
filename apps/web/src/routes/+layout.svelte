<script lang="ts">
	import './layout.css';
	import favicon from '#lib/assets/favicon.svg';
	import { Toaster } from '#lib/components/ui/sonner/index.js';
	import { ModeWatcher } from 'mode-watcher';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Tramline</title>
</svelte:head>

<!-- its first-paint script lives in app.html so it can carry the CSP nonce -->
<ModeWatcher defaultMode="dark" disableHeadScriptInjection />
<Toaster richColors position="bottom-right" />

{@render children()}
