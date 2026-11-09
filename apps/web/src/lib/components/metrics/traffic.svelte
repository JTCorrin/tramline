<script lang="ts">
	import { api, ApiError } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { formatBytes, timeAgo } from '#lib/format.js';
	import { reportError } from '#lib/forms.js';
	import { cn } from '#lib/utils.js';
	import type { Traffic, TrafficQuery } from '@tramline/contracts';
	import XIcon from '@lucide/svelte/icons/x';

	/**
	 * Who reached the service and how it answered: requests to its public
	 * domains and connections to its TCP proxy, with the network each address
	 * belongs to. Owners and admins only.
	 */
	let { serviceId, environmentId }: { serviceId: string; environmentId: string } = $props();

	const client = api();
	const RANGES = ['1h', '24h', '7d'] as const;
	const STATUSES = ['2xx', '3xx', '4xx', '5xx', 'tcp'] as const;

	let range = $state<TrafficQuery['range']>('24h');
	let status = $state<TrafficQuery['status']>(undefined);
	let clientFilter = $state<string | undefined>(undefined);
	let asn = $state<number | undefined>(undefined);
	let pathInput = $state('');
	let path = $state('');
	let data = $state<Traffic | null>(null);
	let forbidden = $state(false);

	const load = () =>
		client.metrics
			.traffic(serviceId, {
				environmentId,
				range,
				status,
				client: clientFilter,
				asn,
				path: path || undefined
			})
			.then((result) => (data = result))
			.catch((error) => {
				if (error instanceof ApiError && error.status === 403) forbidden = true;
				else reportError(error);
			});

	// typing a path waits for a pause before asking
	$effect(() => {
		const value = pathInput.trim();
		const timer = setTimeout(() => (path = value), 300);
		return () => clearTimeout(timer);
	});

	$effect(() => {
		void [range, status, clientFilter, asn, path];
		void load();
		const timer = setInterval(load, 30_000);
		return () => clearInterval(timer);
	});

	const OUTCOMES: Record<string, string> = {
		proxied: 'connected',
		refused: 'refused: not on the allowlist',
		plaintext: 'refused: no TLS'
	};
	const tone = (label: string) =>
		label.startsWith('5')
			? 'text-destructive'
			: label.startsWith('4') || label === 'refused' || label === 'plaintext'
				? 'text-amber-600 dark:text-amber-400'
				: 'text-muted-foreground';
	const networkName = (name: string | null, number: number | null) =>
		name ?? (number ? `AS${number}` : 'Unknown network');
	const pick = (
		set: (value: string | number | undefined) => void,
		current: unknown,
		value: string | number | undefined
	) => set(current === value ? undefined : value);
</script>

<div class="space-y-4" data-testid="traffic">
	{#if forbidden}
		<p class="text-sm text-muted-foreground">
			Only the organization's owners and admins can see who reached this service: access logs hold
			visitors' addresses.
		</p>
	{:else}
		<div class="flex flex-wrap items-center gap-2">
			<div class="inline-flex rounded-md border p-0.5 text-xs" role="group" aria-label="Time range">
				{#each RANGES as option (option)}
					<button
						type="button"
						aria-pressed={range === option}
						class={cn(
							'rounded px-2 py-0.5 text-muted-foreground hover:text-foreground',
							range === option && 'bg-muted font-medium text-foreground'
						)}
						onclick={() => (range = option)}>{option}</button
					>
				{/each}
			</div>
			<div class="inline-flex rounded-md border p-0.5 text-xs" role="group" aria-label="Status">
				{#each STATUSES as option (option)}
					<button
						type="button"
						aria-pressed={status === option}
						class={cn(
							'rounded px-2 py-0.5 text-muted-foreground hover:text-foreground',
							status === option && 'bg-muted font-medium text-foreground'
						)}
						onclick={() => pick((v) => (status = v as typeof status), status, option)}
						>{option === 'tcp' ? 'TCP' : option}</button
					>
				{/each}
			</div>
			<Input
				class="h-7 w-40 text-xs"
				placeholder="Path contains…"
				aria-label="Path contains"
				bind:value={pathInput}
			/>
			{#if clientFilter}
				<Button size="sm" variant="outline" class="h-7" onclick={() => (clientFilter = undefined)}>
					{clientFilter}
					<XIcon class="size-3" />
				</Button>
			{/if}
			{#if asn !== undefined}
				<Button size="sm" variant="outline" class="h-7" onclick={() => (asn = undefined)}>
					AS{asn}
					<XIcon class="size-3" />
				</Button>
			{/if}
		</div>

		{#if data}
			<div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
				<span class="font-medium" data-testid="traffic-total"
					>{data.total.toLocaleString()} {data.total === 1 ? 'request' : 'requests'}</span
				>
				{#each data.statuses as s (s.status)}
					<span class={cn('text-xs', tone(s.status))}
						>{OUTCOMES[s.status] ?? s.status}: {s.count.toLocaleString()}</span
					>
				{/each}
			</div>

			{#if data.total}
				<div class="grid gap-3 sm:grid-cols-2">
					<section class="space-y-1">
						<h3 class="text-xs font-medium text-muted-foreground">Top addresses</h3>
						<ul class="divide-y rounded-lg border text-xs">
							{#each data.topClients as c (c.client)}
								<li>
									<button
										type="button"
										class="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-muted"
										onclick={() =>
											pick((v) => (clientFilter = v as string), clientFilter, c.client)}
									>
										<code class="truncate">{c.client}</code>
										<span class="truncate text-muted-foreground">{c.network ?? ''}</span>
										<span class="ml-auto tabular-nums">{c.count.toLocaleString()}</span>
									</button>
								</li>
							{/each}
						</ul>
					</section>
					<section class="space-y-1">
						<h3 class="text-xs font-medium text-muted-foreground">Top networks</h3>
						<ul class="divide-y rounded-lg border text-xs" data-testid="traffic-networks">
							{#each data.topNetworks as n (n.asn ?? 'none')}
								<li>
									<button
										type="button"
										class="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-muted disabled:hover:bg-transparent"
										disabled={n.asn === null}
										onclick={() => pick((v) => (asn = v as number), asn, n.asn ?? undefined)}
									>
										<span class="truncate">{networkName(n.network, n.asn)}</span>
										{#if n.asn}<span class="text-muted-foreground">AS{n.asn}</span>{/if}
										<span class="ml-auto tabular-nums">{n.count.toLocaleString()}</span>
									</button>
								</li>
							{/each}
						</ul>
					</section>
				</div>

				<section class="space-y-1">
					<h3 class="text-xs font-medium text-muted-foreground">Newest</h3>
					<ul class="divide-y rounded-lg border text-xs">
						{#each data.entries as e, i (i)}
							<li class="space-y-0.5 px-2 py-1.5" data-testid="traffic-entry">
								<div class="flex items-center gap-2">
									{#if e.kind === 'http'}
										<span class={cn('tabular-nums', tone(String(e.status)))}>{e.status}</span>
										<span class="font-medium">{e.method}</span>
										<code class="min-w-0 flex-1 truncate" title={e.path ?? ''}>{e.path}</code>
									{:else}
										<span class={tone(e.outcome ?? '')}>TCP</span>
										<span class="min-w-0 flex-1 truncate"
											>{OUTCOMES[e.outcome ?? ''] ?? e.outcome}</span
										>
									{/if}
									<span class="text-muted-foreground">{timeAgo(e.at)}</span>
								</div>
								<div class="flex flex-wrap gap-x-2 text-muted-foreground">
									<code>{e.client}</code>
									<span>{networkName(e.network, e.asn)}</span>
									{#if e.host}<span>{e.host}</span>{/if}
									<span>{Math.round(e.durationMs)} ms · {formatBytes(e.bytes)}</span>
									{#if e.nodeName}<span>via {e.nodeName}</span>{/if}
									{#if e.weight > 1}<span title="Successful requests are sampled on busy services"
											>×{e.weight}</span
										>{/if}
									{#if e.userAgent}<span class="w-full truncate" title={e.userAgent}
											>{e.userAgent}</span
										>{/if}
								</div>
							</li>
						{/each}
					</ul>
				</section>
			{:else}
				<p class="text-xs text-muted-foreground">
					Nothing yet. Requests to the service's public domains and connections to its TCP proxy
					show here.
				</p>
			{/if}

			<p class="text-xs text-muted-foreground">
				Kept for {data.settings.retentionDays} days.
				{data.settings.anonymised ? 'Addresses are anonymised.' : ''}
				{data.settings.networks
					? 'Networks are looked up on this install; addresses are never sent anywhere.'
					: 'Network names are off or still loading.'}
			</p>
		{/if}
	{/if}
</div>
