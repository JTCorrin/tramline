<script lang="ts">
	import { api } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { reportError } from '#lib/forms.js';
	import type { CustomDomain, CustomDomainRoute } from '@tramline/contracts';
	import { toast } from 'svelte-sonner';

	let {
		serviceId,
		environmentId,
		version,
		hasPort
	}: { serviceId: string; environmentId: string; version: number; hasPort: boolean } = $props();

	const client = api();
	let domains = $state<CustomDomain[]>([]);
	let hostname = $state('');
	let busy = $state(false);
	/** The tunnel's domain, when this install has one and the viewer can publish through it. */
	let tunnelZone = $state<string | null>(null);
	let route = $state<CustomDomainRoute>('direct');

	$effect(() => {
		// only install admins can see public access, or publish through the tunnel
		client.publicAccess
			.get()
			.then((access) => {
				tunnelZone = access.tunnel?.nodeId ? access.tunnel.zoneName : null;
				if (tunnelZone) route = 'tunnel';
			})
			.catch(() => (tunnelZone = null));
	});

	$effect(() => {
		void version;
		client.domains
			.getAll({ serviceId, environmentId })
			.then((list) => (domains = list))
			.catch(reportError);
	});

	async function add(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		try {
			const added = await client.domains.create({
				serviceId,
				environmentId,
				hostname,
				route: tunnelZone ? route : 'direct'
			});
			domains = [...domains, added].sort((a, b) => a.hostname.localeCompare(b.hostname));
			hostname = '';
			if (added.route === 'tunnel') toast.success(`Published at https://${added.hostname}`);
		} catch (error) {
			reportError(error);
		} finally {
			busy = false;
		}
	}

	async function verify(domain: CustomDomain) {
		try {
			const checked = await client.domains.verify(domain.id);
			domains = domains.map((d) => (d.id === checked.id ? checked : d));
			if (checked.status === 'verified') toast.success(`${checked.hostname} is verified`);
			else toast.message(checked.error ?? 'Not verified yet');
		} catch (error) {
			reportError(error);
		}
	}

	async function remove(domain: CustomDomain) {
		try {
			await client.domains.remove(domain.id);
			domains = domains.filter((d) => d.id !== domain.id);
		} catch (error) {
			reportError(error);
		}
	}
</script>

<div class="space-y-3" data-testid="custom-domains">
	<div>
		<div class="text-sm font-medium">Custom domains</div>
		<p class="text-xs text-muted-foreground">
			{#if tunnelZone}
				Publish it through your Cloudflare tunnel under {tunnelZone}: Tramline creates the DNS
				record, and it's live in a minute with no ports to open. Or use a domain whose DNS you
				manage.
			{:else}
				Serve this service on your own domain. Traffic is routed once a DNS record proves the domain
				is yours.
			{/if}
			{hasPort ? '' : 'The service needs a port first.'}
		</p>
	</div>
	{#each domains as domain (domain.id)}
		<div class="space-y-2 rounded-lg border p-3 text-sm" data-testid="custom-domain">
			<div class="flex items-center gap-2">
				<span class="min-w-0 flex-1 truncate font-mono">{domain.hostname}</span>
				{#if domain.route === 'tunnel'}
					<a
						class="text-xs text-emerald-600 underline-offset-2 hover:underline dark:text-emerald-400"
						href={`https://${domain.hostname}`}
						target="_blank"
						rel="noreferrer">Through the tunnel</a
					>
				{:else}
					<span
						class={domain.status === 'verified'
							? 'text-xs text-emerald-600 dark:text-emerald-400'
							: 'text-xs text-amber-600 dark:text-amber-400'}
					>
						{domain.status === 'verified' ? 'Verified' : 'Waiting for DNS'}
					</span>
				{/if}
				{#if domain.status === 'pending'}
					<Button variant="outline" size="sm" onclick={() => verify(domain)}>Check now</Button>
				{/if}
				<Button variant="ghost" size="sm" onclick={() => remove(domain)}>Remove</Button>
			</div>
			{#if domain.status === 'pending'}
				<div class="grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-1 text-xs">
					<span class="text-muted-foreground">Type</span>
					<span class="text-muted-foreground">Name</span>
					<span class="text-muted-foreground">Value</span>
					<span class="font-mono">TXT</span>
					<code class="truncate font-mono" title={domain.verification.name}
						>{domain.verification.name}</code
					>
					<code class="truncate font-mono" title={domain.verification.value}
						>{domain.verification.value}</code
					>
					{#if domain.target}
						<span class="font-mono">CNAME</span>
						<code class="truncate font-mono">{domain.hostname}</code>
						<code class="truncate font-mono">{domain.target}</code>
					{/if}
				</div>
				{#if domain.error}
					<p class="text-xs text-muted-foreground">
						{domain.error}. Tramline checks again every few minutes.
					</p>
				{/if}
			{/if}
		</div>
	{/each}
	<form class="space-y-2" onsubmit={add}>
		{#if tunnelZone}
			<div class="flex flex-wrap gap-4 text-sm" role="radiogroup" aria-label="How it's reached">
				<label class="flex items-center gap-2">
					<input type="radio" name="route" value="tunnel" bind:group={route} />
					Through the tunnel
				</label>
				<label class="flex items-center gap-2">
					<input type="radio" name="route" value="direct" bind:group={route} />
					DNS I manage
				</label>
			</div>
		{/if}
		<div class="flex gap-2">
			<Input
				aria-label="Custom domain"
				placeholder={tunnelZone && route === 'tunnel' ? `app.${tunnelZone}` : 'app.example.com'}
				bind:value={hostname}
				class="font-mono"
				required
			/>
			<Button type="submit" variant="outline" disabled={busy}>
				{busy ? 'Adding…' : tunnelZone && route === 'tunnel' ? 'Publish' : 'Add'}
			</Button>
		</div>
	</form>
</div>
