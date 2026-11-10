<script lang="ts">
	import { api } from '#lib/api.js';
	import { timeAgo } from '#lib/format.js';
	import { reportError } from '#lib/forms.js';
	import type { NodeSummary, SshFailures } from '@tramline/contracts';

	/** Failed SSH logins on a node over the last day, from its auth log. Install admins only. */
	let { node }: { node: NodeSummary } = $props();

	const client = api();
	let open = $state(false);
	let data = $state<SshFailures | null>(null);

	$effect(() => {
		if (!open) return;
		const load = () =>
			client.metrics
				.ssh(node.id)
				.then((result) => (data = result))
				.catch(reportError);
		void load();
		const timer = setInterval(load, 30_000);
		return () => clearInterval(timer);
	});
</script>

<div class="mt-1" data-testid="ssh-failures">
	{#if node.sshWatch === 'unavailable'}
		<p class="text-xs text-muted-foreground">
			Failed SSH logins aren't tracked here: the node has no <code>/var/log/auth.log</code> or
			<code>/var/log/secure</code> (it only keeps the systemd journal). Installing rsyslog adds one.
		</p>
	{:else if node.sshWatch === 'watching'}
		<button
			type="button"
			class="text-xs text-muted-foreground underline-offset-2 hover:underline"
			aria-expanded={open}
			onclick={() => (open = !open)}>{open ? 'Hide failed SSH logins' : 'Failed SSH logins'}</button
		>
		{#if open && data}
			<div class="mt-2 space-y-1 text-xs">
				<p class="text-muted-foreground">
					{data.total
						? `${data.total.toLocaleString()} in the last day, from ${data.addresses.toLocaleString()} ${data.addresses === 1 ? 'address' : 'addresses'}.`
						: 'None in the last day.'}
					{data.total
						? 'Bots try this on any machine on the internet; key-only logins keep them out.'
						: ''}
				</p>
				{#if data.top.length}
					<ul class="divide-y rounded-lg border">
						{#each data.top as t (t.client)}
							<li class="flex flex-wrap items-center gap-x-2 px-2 py-1" data-testid="ssh-failure">
								<code>{t.client}</code>
								<span class="text-muted-foreground">{t.network ?? 'Unknown network'}</span>
								{#if t.user}<span class="text-muted-foreground">as {t.user}</span>{/if}
								<span class="ml-auto tabular-nums">{t.count.toLocaleString()}</span>
								<span class="text-muted-foreground">{timeAgo(t.lastAt)}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	{/if}
</div>
