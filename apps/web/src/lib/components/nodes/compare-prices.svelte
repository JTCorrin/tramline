<script lang="ts">
	import { api } from '#lib/api.js';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { reportError } from '#lib/forms.js';
	import { timeAgo } from '#lib/format.js';
	import { formatMemory, tooSmall } from '#lib/offers.js';
	import type {
		AdapterAccount,
		AdapterRegion,
		Placement,
		PlacementRequest
	} from '@tramline/contracts';
	import { toast } from 'svelte-sonner';

	/**
	 * "Where should this run?": what a workload needs, then where it fits.
	 * Room on a node costs nothing more; after that, every size that fits in
	 * the regions priced so far, from every account, cheapest a month first,
	 * each a click from being created.
	 */
	let {
		accounts,
		oncreated
	}: {
		accounts: AdapterAccount[];
		/** A machine is being created: the page refreshes what's provisioning. */
		oncreated: () => void;
	} = $props();

	let vcpus = $state(2);
	let memoryGb = $state(4);
	let gpus = $state(0);
	let gpuModel = $state('');
	let arch = $state<'any' | 'amd64' | 'arm64'>('any');
	let spot = $state(false);

	let result = $state<Placement | null>(null);
	let busy = $state(false);
	/** The region picker: an account, then one of its regions to add. */
	let account = $state('');
	let regions = $state<AdapterRegion[]>([]);
	let region = $state('');
	/** The option whose Create form is open, and the name typed for it. */
	let creating = $state<string | null>(null);
	let name = $state('');

	const priced = $derived(accounts.filter((a) => a.adapter !== 'manual'));
	const SHOWN = 25;

	function request(extra: PlacementRequest['regions'] = []): PlacementRequest {
		return {
			vcpus,
			memoryMb: Math.round(memoryGb * 1024),
			...(arch === 'any' ? {} : { arch }),
			gpus: gpus > 0 ? { count: gpus, model: gpuModel.trim() || null, minVramGb: null } : null,
			spot,
			regions: extra
		};
	}

	async function compare(extra: PlacementRequest['regions'] = []) {
		busy = true;
		try {
			result = await api().adapters.placement(request(extra));
		} catch (error) {
			reportError(error);
		} finally {
			busy = false;
		}
	}

	async function chooseAccount(value: string) {
		account = value;
		region = '';
		regions = [];
		try {
			regions = await api().adapters.regions(value);
		} catch (error) {
			reportError(error);
		}
	}

	async function addRegion() {
		if (!account || !region) return;
		await compare([{ account, region }]);
		region = '';
	}

	$effect(() => {
		if (!result && priced.length) void compare();
	});

	const key = (o: Placement['offers'][number]) => `${o.account.id}/${o.offer.region}/${o.offer.id}`;
	const money = (n: number) => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString()}`);

	function open(o: Placement['offers'][number]) {
		creating = key(o);
		const base = `${o.offer.region}-${o.offer.id}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
		name =
			base
				.replace(/^-+|-+$/g, '')
				.slice(0, 40)
				.replace(/-+$/, '') || 'node';
	}

	async function create(o: Placement['offers'][number]) {
		const cost =
			o.monthly === null
				? `${o.account.name} doesn't say what ${o.offer.name} costs.`
				: `${o.offer.name} costs about ${money(o.monthly)} a month${o.spot ? ' at today’s spot price, and the provider may take it back' : ''}, for as long as it runs, whether or not anything uses it.`;
		if (!confirm(`${cost} Create ${name.trim()} on ${o.account.name} in ${o.offer.region}?`))
			return;
		try {
			const started = await api().adapters.provision({
				account: o.account.id,
				name: name.trim(),
				region: o.offer.region,
				offer: o.offer.id,
				cordoned: false
			});
			toast.success(`Creating ${started.name}. It appears as a node once it has enrolled.`);
			creating = null;
			oncreated();
		} catch (error) {
			reportError(error);
		}
	}
</script>

<Card.Root data-testid="compare-prices">
	<Card.Header>
		<Card.Title>Where should this run?</Card.Title>
		<Card.Description>
			Say what a workload needs to see where it fits: on a node with room to spare, which costs
			nothing more, or on a new machine from any of your compute accounts, cheapest first. Prices
			come from each provider and are refreshed daily.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		{#if !priced.length}
			<p class="text-sm text-muted-foreground">
				Connect a compute account below to compare its machine sizes and prices.
			</p>
		{:else}
			<form
				class="flex flex-wrap items-end gap-3"
				onsubmit={(e) => {
					e.preventDefault();
					void compare();
				}}
			>
				<Field.Field class="w-24">
					<Field.Label for="compare-cpus">vCPUs</Field.Label>
					<Input id="compare-cpus" type="number" min="0.25" step="0.25" bind:value={vcpus} />
				</Field.Field>
				<Field.Field class="w-28">
					<Field.Label for="compare-memory">Memory (GB)</Field.Label>
					<Input id="compare-memory" type="number" min="0.25" step="0.25" bind:value={memoryGb} />
				</Field.Field>
				<Field.Field class="w-20">
					<Field.Label for="compare-gpus">GPUs</Field.Label>
					<Input id="compare-gpus" type="number" min="0" max="16" bind:value={gpus} />
				</Field.Field>
				{#if gpus > 0}
					<Field.Field class="w-32">
						<Field.Label for="compare-gpu-model">GPU model</Field.Label>
						<Input id="compare-gpu-model" placeholder="Any" bind:value={gpuModel} />
					</Field.Field>
				{/if}
				<Field.Field class="w-32">
					<Field.Label>Architecture</Field.Label>
					<Select.Root type="single" bind:value={arch}>
						<Select.Trigger aria-label="Architecture"
							>{arch === 'any' ? 'Any' : arch}</Select.Trigger
						>
						<Select.Content>
							<Select.Item value="any">Any</Select.Item>
							<Select.Item value="amd64">amd64</Select.Item>
							<Select.Item value="arm64">arm64</Select.Item>
						</Select.Content>
					</Select.Root>
				</Field.Field>
				<label class="flex items-center gap-2 pb-2 text-sm">
					<Switch bind:checked={spot} aria-label="Spot prices" />
					Spot
				</label>
				<Button type="submit" disabled={busy}>
					{#if busy}<Loader2Icon class="size-4 animate-spin" />{/if}
					Compare
				</Button>
			</form>
			{#if spot}
				<p class="text-xs text-muted-foreground">
					Spot machines cost less but the provider can take them back at short notice. Only for work
					that can stop and start again elsewhere.
				</p>
			{/if}

			<div class="flex flex-wrap items-end gap-2">
				<Field.Field class="w-48">
					<Field.Label>Add a region from</Field.Label>
					<Select.Root type="single" value={account} onValueChange={(v) => chooseAccount(v)}>
						<Select.Trigger aria-label="Account"
							>{priced.find((a) => a.id === account)?.name ?? 'Choose an account'}</Select.Trigger
						>
						<Select.Content>
							{#each priced as a (a.id)}
								<Select.Item value={a.id}>{a.name}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</Field.Field>
				{#if account}
					<Field.Field class="w-56">
						<Select.Root type="single" bind:value={region}>
							<Select.Trigger aria-label="Region"
								>{regions.find((r) => r.id === region)?.name ??
									(regions.length ? 'Choose a region' : 'Loading…')}</Select.Trigger
							>
							<Select.Content>
								{#each regions as r (r.id)}
									<Select.Item value={r.id}>{r.name}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</Field.Field>
					<Button variant="outline" disabled={!region || busy} onclick={addRegion}>Add</Button>
				{/if}
			</div>

			{#if result}
				{#if result.regions.length}
					<div class="flex flex-wrap gap-1.5 text-xs" data-testid="compared-regions">
						{#each result.regions as r (`${r.account.id}/${r.region}`)}
							<Badge
								variant={r.error ? 'destructive' : 'secondary'}
								title={r.error ?? (r.fetchedAt ? `Prices from ${timeAgo(r.fetchedAt)}` : '')}
								>{r.account.name} · {r.region}{r.error ? ': prices unavailable' : ''}</Badge
							>
						{/each}
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">
						No regions priced yet. Add one above; the regions your node pools use are priced
						automatically.
					</p>
				{/if}

				{#if result.existing.length}
					<ul class="divide-y rounded-lg border text-sm" data-testid="placement-existing">
						{#each result.existing as n (n.nodeId)}
							<li class="flex flex-wrap items-center gap-x-3 px-3 py-2">
								<span class="font-medium">{n.name}</span>
								<span class="text-xs text-muted-foreground">
									{n.freeCpus} vCPU and {formatMemory(n.freeMemoryMb)} free{n.freeGpus
										? `, ${n.freeGpus} GPU${n.freeGpus === 1 ? '' : 's'}`
										: ''}
								</span>
								<span class="ml-auto text-xs">Already running: nothing more to pay</span>
							</li>
						{/each}
					</ul>
				{/if}

				{#if result.offers.length}
					<ul class="divide-y rounded-lg border text-sm" data-testid="placement-offers">
						{#each result.offers.slice(0, SHOWN) as o (key(o))}
							<li class="space-y-2 px-3 py-2" data-testid="placement-offer">
								<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
									<span class="font-medium">{o.offer.name}</span>
									<span class="text-xs text-muted-foreground"
										>{o.account.name} · {o.offer.region} · {o.offer.vcpus} vCPU · {formatMemory(
											o.offer.memoryMb
										)}{o.offer.gpu ? ` · ${o.offer.gpu.count}× ${o.offer.gpu.model}` : ''} · {o
											.offer.arch}</span
									>
									<span class="ml-auto tabular-nums" data-testid="placement-monthly">
										{#if o.monthly !== null}
											{money(o.monthly)}/mo{#if o.spot}<Badge variant="outline" class="ml-1.5"
													>spot</Badge
												>{/if}
										{:else}
											<span class="text-muted-foreground">Price unknown</span>
										{/if}
									</span>
									{#if creating !== key(o)}
										<Button size="sm" variant="outline" onclick={() => open(o)}>Create node</Button>
									{/if}
								</div>
								{#if creating === key(o)}
									<form
										class="flex flex-wrap items-center gap-2"
										onsubmit={(e) => {
											e.preventDefault();
											void create(o);
										}}
									>
										<Input
											class="w-56"
											aria-label="Node name"
											bind:value={name}
											pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
											maxlength={40}
											required
										/>
										<Button size="sm" type="submit">Create</Button>
										<Button size="sm" variant="ghost" onclick={() => (creating = null)}
											>Cancel</Button
										>
										{#if tooSmall(o.offer)}
											<span class="w-full text-xs text-amber-600 dark:text-amber-400"
												>{tooSmall(o.offer)}</span
											>
										{/if}
									</form>
								{/if}
							</li>
						{/each}
					</ul>
					{#if result.offers.length > SHOWN}
						<p class="text-xs text-muted-foreground">
							The {SHOWN} cheapest of {result.offers.length} sizes that fit.
						</p>
					{/if}
				{:else if result.regions.length}
					<p class="text-sm text-muted-foreground" data-testid="placement-none">
						No size in the regions priced so far fits that. Try another region, or ask for less.
					</p>
				{/if}
			{/if}
		{/if}
	</Card.Content>
</Card.Root>
