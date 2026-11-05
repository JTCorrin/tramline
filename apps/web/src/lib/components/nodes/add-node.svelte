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
	import type {
		AdapterAccount,
		AdapterOffer,
		AdapterRegion,
		CreatedJoinToken,
		ProvisioningNode,
		PublicAccess
	} from '@tramline/contracts';
	import { toast } from 'svelte-sonner';

	/**
	 * Adds a node: with a command to run on a machine you have (the manual
	 * adapter), or by having a compute account create one, which enrolls itself.
	 */
	let {
		accounts,
		provisioning = $bindable(),
		access = null
	}: {
		accounts: AdapterAccount[];
		provisioning: ProvisioningNode[];
		access?: PublicAccess | null;
	} = $props();

	const MANUAL = 'manual';
	let source = $state(MANUAL);
	let name = $state('');
	let startCordoned = $state(false);
	let joining = $state<CreatedJoinToken | null>(null);

	let regions = $state<AdapterRegion[]>([]);
	let region = $state('');
	let offers = $state<AdapterOffer[]>([]);
	let offer = $state('');
	let busy = $state(false);
	const account = $derived(accounts.find((a) => a.id === source));

	/** Why a machine an account creates can't reach this install yet, if we can tell. */
	const unreachable = $derived.by(() => {
		if (!account || !access) return null;
		const tunnel = access.tunnel;
		if (tunnel && tunnel.status !== 'healthy' && tunnel.status !== 'degraded') {
			return `The Cloudflare tunnel isn't connected, so new machines can't reach Tramline. Start its connector under Public access first.`;
		}
		if (!access.agentUrl) {
			return `New machines will connect to ${location.origin}, the address you opened Tramline at. Machines in a cloud can't reach that unless it's public; set one up under Public access.`;
		}
		return null;
	});

	/** Most machines enroll within a few minutes; past this, say what to check. */
	const SLOW_MS = 5 * 60_000;
	const slow = (pending: ProvisioningNode) =>
		!pending.expired && Date.now() - new Date(pending.createdAt).getTime() > SLOW_MS;

	$effect(() => {
		// poll while machines boot and enroll
		if (!provisioning.length) return;
		const timer = setInterval(refresh, 5_000);
		return () => clearInterval(timer);
	});

	async function refresh() {
		try {
			provisioning = await api().adapters.provisioning();
		} catch {
			// keep showing the last list
		}
	}

	async function choose(value: string) {
		source = value;
		regions = [];
		offers = [];
		region = '';
		offer = '';
		if (value === MANUAL) return;
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
			offers = await api().adapters.offers(source, value);
			offer = offers[0]?.id ?? '';
		} catch (error) {
			reportError(error);
		}
	}

	async function add(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		try {
			if (source === MANUAL) {
				joining = await api().nodes.join({ name: name.trim(), cordoned: startCordoned });
			} else {
				const started = await api().adapters.provision({
					account: source,
					name: name.trim(),
					region,
					offer,
					cordoned: startCordoned
				});
				toast.success(`Creating ${started.name}. It appears as a node once it has enrolled.`);
				await refresh();
			}
			name = '';
		} catch (error) {
			reportError(error);
		} finally {
			busy = false;
		}
	}

	async function cancel(pending: ProvisioningNode) {
		if (!confirm(`Destroy ${pending.name}'s machine on ${pending.account.name}?`)) return;
		try {
			await api().adapters.cancel(pending.id);
			provisioning = provisioning.filter((p) => p.id !== pending.id);
		} catch (error) {
			reportError(error);
		}
	}

	const gb = (mb: number) => `${Math.round(mb / 1024)} GB`;
	const describe = (o: AdapterOffer) =>
		[
			o.name,
			`${o.vcpus} vCPU`,
			gb(o.memoryMb),
			o.gpu ? `${o.gpu.count}× ${o.gpu.model}` : null,
			o.hourly !== null ? `$${o.hourly.toFixed(3)}/h` : null
		]
			.filter(Boolean)
			.join(' · ');
</script>

<Card.Root data-testid="add-node">
	<Card.Header>
		<Card.Title>Add a node</Card.Title>
		<Card.Description>
			Any Linux machine with Docker: a VM, a VPS, a spare box. Run the command on it as root, or
			have a compute account create the machine. Either way the agent connects out to Tramline, so
			the machine needs no open ports for it.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		{#if joining}
			<div class="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
				<p class="font-medium">
					Run this on the new machine. The token works once and expires {timeAgo(
						joining.expiresAt
					)}.
				</p>
				<div class="flex gap-2">
					<Input
						readonly
						value={joining.command}
						class="font-mono text-xs"
						data-testid="join-command"
					/>
					<Button
						variant="outline"
						onclick={() =>
							navigator.clipboard.writeText(joining!.command).then(() => toast.success('Copied'))}
						>Copy</Button
					>
				</div>
				<p class="text-xs text-muted-foreground">
					It installs nothing but the agent, which runs as a container with access to the Docker
					socket. Read the script first with <code
						>curl -fsSL {new URL(joining.command.split(' ')[2]!).origin}/install.sh</code
					>.
				</p>
				<Button variant="ghost" size="sm" onclick={() => (joining = null)}>Done</Button>
			</div>
		{/if}
		<form class="flex flex-wrap items-end gap-3" onsubmit={add}>
			{#if accounts.length}
				<Field.Field class="min-w-48">
					<Field.Label for="node-source">Machine</Field.Label>
					<Select.Root type="single" value={source} onValueChange={choose}>
						<Select.Trigger id="node-source" class="w-full" aria-label="Machine"
							>{account ? `New machine on ${account.name}` : 'One I already have'}</Select.Trigger
						>
						<Select.Content>
							<Select.Item value={MANUAL}>One I already have</Select.Item>
							{#each accounts as option (option.id)}
								<Select.Item value={option.id}>New machine on {option.name}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</Field.Field>
			{/if}
			<Field.Field class="min-w-48 flex-1">
				<Field.Label for="node-name">Name</Field.Label>
				<Input id="node-name" placeholder="hetzner-1" bind:value={name} required />
			</Field.Field>
			{#if account}
				<Field.Field class="min-w-40">
					<Field.Label for="node-region">Region</Field.Label>
					<Select.Root type="single" value={region} onValueChange={chooseRegion}>
						<Select.Trigger id="node-region" class="w-full" aria-label="Region"
							>{regions.find((r) => r.id === region)?.name ?? 'Loading…'}</Select.Trigger
						>
						<Select.Content>
							{#each regions as option (option.id)}
								<Select.Item value={option.id}>{option.name}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</Field.Field>
				<Field.Field class="w-full">
					<Field.Label for="node-size">Size</Field.Label>
					<Select.Root type="single" value={offer} onValueChange={(value) => (offer = value)}>
						<Select.Trigger id="node-size" class="w-full" aria-label="Size"
							>{offers.find((o) => o.id === offer)
								? describe(offers.find((o) => o.id === offer)!)
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
			{/if}
			<label
				class="flex h-9 items-center gap-2 text-sm"
				title="The node joins but runs nothing until you uncordon it"
			>
				<Switch bind:checked={startCordoned} aria-label="Start cordoned" />
				Start cordoned
			</label>
			<Button type="submit" disabled={busy || (!!account && !offer)}>
				{#if busy}
					<Loader2Icon class="size-4 animate-spin" />
					{account ? 'Creating machine…' : 'Creating…'}
				{:else}
					{account ? 'Create machine' : 'Create join command'}
				{/if}
			</Button>
		</form>
		<p class="text-xs text-muted-foreground">
			<strong>Start cordoned</strong> adds the node without placing any services on it, until you uncordon
			it. Useful to check a machine first.
		</p>
		{#if unreachable}
			<p
				class="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
				data-testid="unreachable"
			>
				{unreachable}
			</p>
		{/if}

		{#if provisioning.length}
			<ul class="divide-y rounded-lg border text-sm" data-testid="provisioning">
				{#each provisioning as pending (pending.id)}
					<li class="flex flex-wrap items-center gap-3 px-3 py-2" data-testid="provisioning-node">
						<span class="font-medium">{pending.name}</span>
						<span class="text-xs text-muted-foreground">
							{pending.account.name}{pending.offer ? ` · ${pending.offer}` : ''} · created {timeAgo(
								pending.createdAt
							)}
						</span>
						{#if pending.expired}
							<Badge variant="destructive">Never enrolled</Badge>
						{:else}
							<Badge variant="secondary">Waiting to enroll</Badge>
						{/if}
						{#if slow(pending)}
							<span class="w-full text-xs text-muted-foreground" data-testid="slow">
								Most machines join within 5 minutes. Check that Public access shows a connected
								address the machine can reach; it keeps retrying until its token expires.
							</span>
						{/if}
						<Button class="ml-auto" size="sm" variant="ghost" onclick={() => cancel(pending)}
							>Destroy</Button
						>
					</li>
				{/each}
			</ul>
		{/if}
	</Card.Content>
</Card.Root>
