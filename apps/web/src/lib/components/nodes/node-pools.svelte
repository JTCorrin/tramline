<script lang="ts">
	import { api } from '#lib/api.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import { reportError } from '#lib/forms.js';
	import { timeAgo } from '#lib/format.js';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import type {
		AdapterAccount,
		AdapterOffer,
		AdapterRegion,
		NodePool,
		UpdateNodePool
	} from '@tramline/contracts';
	import { toast } from 'svelte-sonner';

	/**
	 * Node pools: machines Tramline adds when work has nowhere to run, and
	 * removes once they've been idle. Creating one, or raising its maximum,
	 * says what it can cost first.
	 */
	let { accounts, pools = $bindable() }: { accounts: AdapterAccount[]; pools: NodePool[] } =
		$props();

	const HOURS_PER_MONTH = 730;
	const ALL = 'all';

	let adding = $state(false);
	let busy = $state(false);
	let name = $state('');
	let account = $state('');
	let regions = $state<AdapterRegion[]>([]);
	let region = $state('');
	let offers = $state<AdapterOffer[]>([]);
	let offer = $state('');
	let scope = $state(ALL);
	let minNodes = $state(0);
	let maxNodes = $state(3);
	let idleMinutes = $state(15);
	let monthlyCap = $state('');
	let envs = $state<{ id: string; label: string }[]>([]);

	const chosen = $derived(offers.find((o) => o.id === offer));
	const money = (n: number) => `$${n.toFixed(2)}`;
	const perMonth = (hourly: number | null, machines: number) =>
		hourly === null ? null : hourly * HOURS_PER_MONTH * machines;
	const atMost = $derived.by(() => {
		const max = perMonth(chosen?.hourly ?? null, maxNodes);
		const cap = Number(monthlyCap) || null;
		return max === null ? null : cap !== null ? Math.min(max, cap) : max;
	});

	$effect(() => {
		// pools change by themselves; keep up while one is busy
		if (!pools.some((p) => p.provisioning || p.removing || p.nodes.length)) return;
		const timer = setInterval(refresh, 10_000);
		return () => clearInterval(timer);
	});

	async function refresh() {
		try {
			pools = await api().pools.getAll();
		} catch {
			// keep showing the last list
		}
	}

	async function open() {
		adding = true;
		if (!account && accounts[0]) await chooseAccount(accounts[0].id);
		if (!envs.length) {
			try {
				const projects = await api().projects.getAll();
				const lists = await Promise.all(
					projects.map(async (p) =>
						(await api().environments.getAll({ projectId: p.id })).map((e) => ({
							id: e.id,
							label: `${p.name} / ${e.name}`
						}))
					)
				);
				envs = lists.flat();
			} catch (error) {
				reportError(error);
			}
		}
	}

	async function chooseAccount(value: string) {
		account = value;
		regions = [];
		offers = [];
		region = '';
		offer = '';
		try {
			regions = await api().adapters.regions(value);
			if (regions[0]) await chooseRegion(regions[0].id);
		} catch (error) {
			reportError(error);
		}
	}

	async function chooseRegion(value: string) {
		region = value;
		offer = '';
		try {
			offers = await api().adapters.offers(account, value);
			offer = offers[0]?.id ?? '';
		} catch (error) {
			reportError(error);
		}
	}

	/** What a pool can cost at its maximum, to confirm before it can grow to it. */
	function costLine(machines: number, hourly: number | null, cap: number | null) {
		const max = perMonth(hourly, machines);
		if (max === null) return `up to ${machines} machine${machines === 1 ? '' : 's'}`;
		const limit = cap !== null && cap < max ? ` (capped at ${money(cap)})` : '';
		return `up to ${machines} machine${machines === 1 ? '' : 's'}, about ${money(max)} a month${limit}`;
	}

	async function create(event: SubmitEvent) {
		event.preventDefault();
		const cap = Number(monthlyCap) || null;
		if (
			maxNodes > 0 &&
			!confirm(
				`Tramline will create and destroy machines on ${accounts.find((a) => a.id === account)?.name} by itself: ${costLine(maxNodes, chosen?.hourly ?? null, cap)}. Continue?`
			)
		)
			return;
		busy = true;
		try {
			const pool = await api().pools.create({
				name: name.trim(),
				account,
				region,
				offer,
				environmentId: scope === ALL ? null : scope,
				minNodes,
				maxNodes,
				idleMinutes,
				monthlyCap: cap
			});
			pools = [...pools, pool];
			adding = false;
			name = '';
			toast.success(`Created ${pool.name}`);
		} catch (error) {
			reportError(error);
		} finally {
			busy = false;
		}
	}

	async function change(pool: NodePool, input: UpdateNodePool) {
		const max = input.maxNodes ?? pool.maxNodes;
		const cap = input.monthlyCap !== undefined ? input.monthlyCap : pool.monthlyCap;
		const costlier =
			max > pool.maxNodes ||
			(cap === null && pool.monthlyCap !== null) ||
			(cap ?? 0) > (pool.monthlyCap ?? Infinity);
		if (
			costlier &&
			!confirm(`${pool.name} can now grow to ${costLine(max, pool.offer.hourly, cap)}. Continue?`)
		) {
			await refresh();
			return;
		}
		try {
			const updated = await api().pools.update(pool.id, input);
			pools = pools.map((p) => (p.id === pool.id ? updated : p));
		} catch (error) {
			reportError(error);
			await refresh();
		}
	}

	async function remove(pool: NodePool) {
		const machines = pool.nodes.length + pool.provisioning;
		if (
			!confirm(
				machines
					? `Remove ${pool.name}? Its ${machines} machine${machines === 1 ? ' is' : 's are'} drained and destroyed; deployments on them move to other nodes.`
					: `Remove ${pool.name}?`
			)
		)
			return;
		try {
			const left = await api().pools.remove(pool.id);
			pools = left
				? pools.map((p) => (p.id === pool.id ? left : p))
				: pools.filter((p) => p.id !== pool.id);
		} catch (error) {
			reportError(error);
		}
	}

	const gb = (mb: number) => `${Math.round(mb / 1024)} GB`;
	const describe = (o: { name: string; vcpus: number; memoryMb: number; hourly: number | null }) =>
		[
			o.name,
			`${o.vcpus} vCPU`,
			gb(o.memoryMb),
			o.hourly !== null ? `$${o.hourly.toFixed(3)}/h` : null
		]
			.filter(Boolean)
			.join(' · ');
	const number = (event: Event) => Number((event.currentTarget as HTMLInputElement).value);
</script>

<Card.Root data-testid="node-pools">
	<Card.Header>
		<Card.Title>Node pools</Card.Title>
		<Card.Description>
			Machines Tramline adds by itself when a deployment has nowhere to run, and destroys once
			they've been idle. Each pool uses one account, region and size, between a minimum and a
			maximum.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		{#if pools.length}
			<ul class="space-y-3">
				{#each pools as pool (pool.id)}
					<li class="rounded-lg border p-3 text-sm" data-testid="node-pool" data-pool={pool.name}>
						<div class="flex flex-wrap items-center gap-2">
							<span class="font-medium">{pool.name}</span>
							<span class="text-xs text-muted-foreground">
								{pool.account.name} · {pool.region} · {describe(pool.offer)}
							</span>
							{#if pool.removing}<Badge variant="secondary">Removing</Badge>{/if}
							{#if pool.orphaned}<Badge variant="secondary">Environment deleted</Badge>{/if}
							<span class="ml-auto text-xs text-muted-foreground">
								{pool.nodes.length} running{pool.provisioning
									? `, ${pool.provisioning} starting`
									: ''}
								{#if pool.monthly}· {money(pool.monthly.now)}/month now{/if}
							</span>
						</div>
						<div class="mt-1 text-xs text-muted-foreground">
							{pool.environment
								? `For ${pool.environment.project} / ${pool.environment.name} only`
								: pool.orphaned
									? 'Its environment was deleted, so it takes no new work and shrinks to nothing'
									: 'For every environment'}
							{#if pool.nodes.length}· {pool.nodes.map((n) => n.name).join(', ')}{/if}
						</div>
						{#if pool.error}
							<p class="mt-1 text-xs text-red-400" data-testid="pool-error">
								{pool.error}{pool.errorAt ? ` (${timeAgo(pool.errorAt)})` : ''}
							</p>
						{:else if pool.activity}
							<p class="mt-1 text-xs text-muted-foreground">
								{pool.activity}{pool.activityAt ? ` (${timeAgo(pool.activityAt)})` : ''}
							</p>
						{/if}
						{#if !pool.removing}
							<div class="mt-3 flex flex-wrap items-end gap-3">
								<Field.Field class="w-24">
									<Field.Label for="min-{pool.id}">Minimum</Field.Label>
									<Input
										id="min-{pool.id}"
										type="number"
										min="0"
										max="50"
										value={pool.minNodes}
										onchange={(e) => change(pool, { minNodes: number(e) })}
									/>
								</Field.Field>
								<Field.Field class="w-24">
									<Field.Label for="max-{pool.id}">Maximum</Field.Label>
									<Input
										id="max-{pool.id}"
										type="number"
										min="0"
										max="50"
										value={pool.maxNodes}
										onchange={(e) => change(pool, { maxNodes: number(e) })}
									/>
								</Field.Field>
								<Field.Field class="w-32">
									<Field.Label for="idle-{pool.id}">Idle minutes</Field.Label>
									<Input
										id="idle-{pool.id}"
										type="number"
										min="5"
										value={pool.idleMinutes}
										onchange={(e) => change(pool, { idleMinutes: number(e) })}
									/>
								</Field.Field>
								<Field.Field class="w-36">
									<Field.Label for="cap-{pool.id}">Monthly cap ($)</Field.Label>
									<Input
										id="cap-{pool.id}"
										type="number"
										min="1"
										placeholder="None"
										value={pool.monthlyCap ?? ''}
										onchange={(e) => change(pool, { monthlyCap: number(e) || null })}
									/>
								</Field.Field>
								<Button class="ml-auto" size="sm" variant="ghost" onclick={() => remove(pool)}
									>Remove</Button
								>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if !accounts.length}
			<p class="text-sm text-muted-foreground">
				Pools create machines with a compute account. Connect one under Compute accounts first.
			</p>
		{:else if !adding}
			<Button variant="outline" onclick={open}>New pool</Button>
		{:else}
			<form class="space-y-3 rounded-lg border p-3" onsubmit={create}>
				<div class="flex flex-wrap items-end gap-3">
					<Field.Field class="min-w-40 flex-1">
						<Field.Label for="pool-name">Name</Field.Label>
						<Input id="pool-name" placeholder="web" bind:value={name} required />
					</Field.Field>
					<Field.Field class="min-w-40">
						<Field.Label for="pool-account">Account</Field.Label>
						<Select.Root type="single" value={account} onValueChange={chooseAccount}>
							<Select.Trigger id="pool-account" class="w-full" aria-label="Account"
								>{accounts.find((a) => a.id === account)?.name ?? 'Choose…'}</Select.Trigger
							>
							<Select.Content>
								{#each accounts as option (option.id)}
									<Select.Item value={option.id}>{option.name}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</Field.Field>
					<Field.Field class="min-w-40">
						<Field.Label for="pool-region">Region</Field.Label>
						<Select.Root type="single" value={region} onValueChange={chooseRegion}>
							<Select.Trigger id="pool-region" class="w-full" aria-label="Region"
								>{regions.find((r) => r.id === region)?.name ?? 'Loading…'}</Select.Trigger
							>
							<Select.Content>
								{#each regions as option (option.id)}
									<Select.Item value={option.id}>{option.name}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</Field.Field>
				</div>
				<Field.Field>
					<Field.Label for="pool-size">Size</Field.Label>
					<Select.Root type="single" value={offer} onValueChange={(value) => (offer = value)}>
						<Select.Trigger id="pool-size" class="w-full" aria-label="Size"
							>{chosen
								? describe(chosen)
								: offers.length
									? 'Choose…'
									: 'No sizes here'}</Select.Trigger
						>
						<Select.Content>
							{#each offers as option (option.id)}
								<Select.Item value={option.id}>{describe(option)}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</Field.Field>
				<Field.Field>
					<Field.Label for="pool-scope">For</Field.Label>
					<Select.Root type="single" value={scope} onValueChange={(value) => (scope = value)}>
						<Select.Trigger id="pool-scope" class="w-full" aria-label="For"
							>{scope === ALL
								? 'Every environment'
								: (envs.find((e) => e.id === scope)?.label ?? 'Choose…')}</Select.Trigger
						>
						<Select.Content>
							<Select.Item value={ALL}>Every environment</Select.Item>
							{#each envs as option (option.id)}
								<Select.Item value={option.id}>{option.label} only</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</Field.Field>
				<div class="flex flex-wrap items-end gap-3">
					<Field.Field class="w-24">
						<Field.Label for="pool-min">Minimum</Field.Label>
						<Input id="pool-min" type="number" min="0" max="50" bind:value={minNodes} />
					</Field.Field>
					<Field.Field class="w-24">
						<Field.Label for="pool-max">Maximum</Field.Label>
						<Input id="pool-max" type="number" min="0" max="50" bind:value={maxNodes} />
					</Field.Field>
					<Field.Field class="w-32">
						<Field.Label for="pool-idle">Idle minutes</Field.Label>
						<Input id="pool-idle" type="number" min="5" bind:value={idleMinutes} />
					</Field.Field>
					<Field.Field class="w-36">
						<Field.Label for="pool-cap">Monthly cap ($)</Field.Label>
						<Input id="pool-cap" type="number" min="1" placeholder="None" bind:value={monthlyCap} />
					</Field.Field>
				</div>
				<p class="text-xs text-muted-foreground" data-testid="pool-cost">
					{#if atMost !== null}
						At most about {money(atMost)} a month. Machines are only added for deployments that can't
						run anywhere else and fit this size, and destroyed after {idleMinutes} minutes with nothing
						on them (never below the minimum, and never one holding a service's data).
					{:else}
						This provider doesn't say what its machines cost.
					{/if}
				</p>
				<div class="flex gap-2">
					<Button type="submit" disabled={busy || !offer}>
						{#if busy}<Loader2Icon class="size-4 animate-spin" />{/if}
						Create pool
					</Button>
					<Button variant="ghost" onclick={() => (adding = false)}>Cancel</Button>
				</div>
			</form>
		{/if}
	</Card.Content>
</Card.Root>
