<script lang="ts">
	import { page } from '$app/state';
	import { api } from '#lib/api.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import { reportError } from '#lib/forms.js';
	import type { CloudflareZone, NodeSummary, PublicAccess } from '@tramline/contracts';
	import { toast } from 'svelte-sonner';

	/**
	 * Where new nodes reach this install, and the Cloudflare tunnel Tramline
	 * can set up so machines elsewhere reach one at home or behind NAT.
	 */
	let { access = $bindable(), nodes }: { access: PublicAccess; nodes: NodeSummary[] } = $props();

	const HAND = 'hand';
	/** Agents installed before the tunnel feature can't run its connector. */
	const canRun = (n: NodeSummary) => n.features.includes('tunnel');
	const nodeLabel = (id: string) =>
		id === HAND ? 'I’ll run it myself' : (nodes.find((n) => n.id === id)?.name ?? id);

	let setting = $state(false);
	let busy = $state(false);
	let apiToken = $state('');
	let zones = $state<CloudflareZone[] | null>(null);
	let zoneId = $state('');
	let subdomain = $state('tramline');
	let originUrl = $state('');
	let nodeId = $state(HAND);
	let connector = $state<string | null>(null);
	const zone = $derived(zones?.find((z) => z.id === zoneId));

	function start() {
		setting = true;
		apiToken = '';
		zones = null;
		originUrl = page.url.origin;
		nodeId =
			(
				nodes.find((n) => n.name === 'local' && n.status === 'online' && canRun(n)) ??
				nodes.find((n) => n.status === 'online' && canRun(n))
			)?.id ?? HAND;
	}

	async function findZones(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		try {
			zones = await api().publicAccess.cloudflareZones({ apiToken: apiToken.trim() });
			zoneId = zones[0]!.id;
		} catch (error) {
			reportError(error);
		} finally {
			busy = false;
		}
	}

	async function create(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		try {
			access = await api().publicAccess.createTunnel({
				apiToken: apiToken.trim(),
				zoneId,
				subdomain: subdomain.trim(),
				originUrl: originUrl.trim(),
				nodeId: nodeId === HAND ? null : nodeId
			});
			setting = false;
			apiToken = '';
			toast.success(`Created the tunnel: new nodes connect to ${access.agentUrl}`);
		} catch (error) {
			reportError(error);
		} finally {
			busy = false;
		}
	}

	async function move(value: string) {
		try {
			access = await api().publicAccess.updateTunnel({ nodeId: value === HAND ? null : value });
			connector = null;
		} catch (error) {
			reportError(error);
		}
	}

	async function saveOrigin(event: SubmitEvent) {
		event.preventDefault();
		const value = String(new FormData(event.currentTarget as HTMLFormElement).get('origin') ?? '');
		try {
			access = await api().publicAccess.updateTunnel({ originUrl: value.trim() });
			toast.success('Saved');
		} catch (error) {
			reportError(error);
		}
	}

	async function showConnector() {
		try {
			connector = (await api().publicAccess.connector()).command;
		} catch (error) {
			reportError(error);
		}
	}

	async function remove() {
		const host = access.tunnel?.hostname;
		if (
			!confirm(
				`Remove the tunnel? ${host} stops working, and nodes that joined through it lose their connection.`
			)
		)
			return;
		busy = true;
		try {
			try {
				await api().publicAccess.removeTunnel();
			} catch (error) {
				reportError(error);
				if (
					!confirm(
						'Cloudflare couldn’t remove it. Forget the tunnel anyway? You’d delete it and its DNS record in Cloudflare yourself.'
					)
				)
					return;
				await api().publicAccess.removeTunnel({ force: true });
			}
			access = await api().publicAccess.get();
			connector = null;
			toast.success('Removed the tunnel');
		} catch (error) {
			reportError(error);
		} finally {
			busy = false;
		}
	}

	const STATUS: Record<
		string,
		{ label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
	> = {
		healthy: { label: 'Connected', variant: 'default' },
		degraded: { label: 'Degraded', variant: 'secondary' },
		down: { label: 'Down', variant: 'destructive' },
		inactive: { label: 'Waiting for the connector', variant: 'outline' },
		unknown: { label: 'Status unknown', variant: 'outline' }
	};
</script>

<Card.Root data-testid="public-access">
	<Card.Header>
		<Card.Title>Public access</Card.Title>
		<Card.Description>
			Where new nodes reach this install. Machines in a cloud need a public address; a tunnel gives
			an install at home or behind NAT one without opening a port. The tunnel only carries what
			nodes need, not this dashboard.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4 text-sm">
		<p data-testid="agent-url">
			New nodes connect to
			{#if access.agentUrl}
				<code class="font-mono">{access.agentUrl}</code>{access.source === 'env'
					? ' (from TRAMLINE_AGENT_URL or TRAMLINE_URL)'
					: ''}.
			{:else}
				the address you opened Tramline at, so only machines that can reach it can join.
			{/if}
		</p>

		{#if access.tunnel}
			{@const tunnel = access.tunnel}
			{@const status = STATUS[tunnel.status] ?? STATUS.unknown!}
			<div class="space-y-3 rounded-lg border p-3" data-testid="tunnel">
				<div class="flex flex-wrap items-center gap-2">
					<span class="font-medium">Cloudflare tunnel</span>
					<code class="font-mono text-xs">{tunnel.hostname}</code>
					<Badge variant={status.variant} data-testid="tunnel-status">{status.label}</Badge>
					<Button class="ml-auto" size="sm" variant="ghost" disabled={busy} onclick={remove}>
						Remove
					</Button>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<span class="text-muted-foreground">Connector runs on</span>
					<Select.Root type="single" value={tunnel.nodeId ?? HAND} onValueChange={move}>
						<Select.Trigger class="h-8 w-52" aria-label="Connector node">
							{tunnel.nodeId ? (tunnel.nodeName ?? tunnel.nodeId) : nodeLabel(HAND)}
						</Select.Trigger>
						<Select.Content>
							{#each nodes as n (n.id)}
								<Select.Item value={n.id} disabled={!canRun(n)}
									>{n.name}{canRun(n) ? '' : ' (agent too old)'}</Select.Item
								>
							{/each}
							<Select.Item value={HAND}>{nodeLabel(HAND)}</Select.Item>
						</Select.Content>
					</Select.Root>
				</div>
				{#if tunnel.connectorProblem}
					<p
						class="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3"
						data-testid="connector-problem"
					>
						{tunnel.connectorProblem}
					</p>
				{/if}
				<form class="flex flex-wrap items-center gap-2" onsubmit={saveOrigin}>
					<label for="tunnel-origin" class="text-muted-foreground">It reaches Tramline at</label>
					<Input
						id="tunnel-origin"
						name="origin"
						class="h-8 w-64 font-mono text-xs"
						value={tunnel.originUrl}
					/>
					<Button size="sm" variant="outline" type="submit">Save</Button>
				</form>
				{#if !tunnel.nodeId}
					{#if connector}
						<div class="space-y-1">
							<p class="text-muted-foreground">
								Run this on a machine that can reach {tunnel.originUrl}. It holds the tunnel’s
								secret.
							</p>
							<code
								class="block rounded bg-muted p-2 font-mono text-xs break-all"
								data-testid="tunnel-connector">{connector}</code
							>
						</div>
					{:else}
						<Button size="sm" variant="outline" onclick={showConnector}>Show the command</Button>
					{/if}
				{/if}
			</div>
		{:else if setting}
			{#if !zones}
				<form class="space-y-3 rounded-lg border p-3" onsubmit={findZones}>
					<Field.Field>
						<Field.Label for="cf-token">Cloudflare API token</Field.Label>
						<Input
							id="cf-token"
							type="password"
							autocomplete="off"
							bind:value={apiToken}
							required
						/>
						<Field.Description>
							A custom token with <strong>Account → Cloudflare Tunnel: Edit</strong> and
							<strong>Zone → DNS: Edit</strong> on the domain to use. Tramline keeps it encrypted, to
							change or remove the tunnel later.
						</Field.Description>
					</Field.Field>
					<div class="flex gap-2">
						<Button type="submit" disabled={busy}>Next</Button>
						<Button variant="ghost" onclick={() => (setting = false)}>Cancel</Button>
					</div>
				</form>
			{:else}
				<form class="space-y-3 rounded-lg border p-3" onsubmit={create}>
					<Field.Field>
						<Field.Label for="cf-host">Address</Field.Label>
						<div class="flex items-center gap-1">
							<Input
								id="cf-host"
								class="w-40"
								bind:value={subdomain}
								placeholder="tramline"
								aria-label="Subdomain"
							/>
							<span>.</span>
							<Select.Root type="single" bind:value={zoneId}>
								<Select.Trigger class="w-56" aria-label="Domain">{zone?.name}</Select.Trigger>
								<Select.Content>
									{#each zones as z (z.id)}
										<Select.Item value={z.id}>{z.name}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
						</div>
					</Field.Field>
					<Field.Field>
						<Field.Label for="cf-origin">Tramline’s address for the connector</Field.Label>
						<Input id="cf-origin" class="font-mono text-xs" bind:value={originUrl} required />
						<Field.Description>
							Where the connector reaches this install from the node it runs on, which shares that
							machine’s network, e.g. http://localhost:3000.
						</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label for="cf-node">Run the connector on</Field.Label>
						<Select.Root type="single" bind:value={nodeId}>
							<Select.Trigger id="cf-node" class="w-56" aria-label="Connector node"
								>{nodeLabel(nodeId)}</Select.Trigger
							>
							<Select.Content>
								{#each nodes as n (n.id)}
									<Select.Item value={n.id} disabled={!canRun(n)}
										>{n.name}{canRun(n) ? '' : ' (agent too old)'}</Select.Item
									>
								{/each}
								<Select.Item value={HAND}>{nodeLabel(HAND)}</Select.Item>
							</Select.Content>
						</Select.Root>
					</Field.Field>
					<div class="flex gap-2">
						<Button type="submit" disabled={busy}>Create tunnel</Button>
						<Button variant="ghost" onclick={() => (setting = false)}>Cancel</Button>
					</div>
				</form>
			{/if}
		{:else}
			<Button variant="outline" onclick={start}>Set up a Cloudflare tunnel</Button>
		{/if}
	</Card.Content>
</Card.Root>
