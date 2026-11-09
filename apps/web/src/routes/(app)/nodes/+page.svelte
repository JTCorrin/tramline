<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { api } from '#lib/api.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import AddNode from '#lib/components/nodes/add-node.svelte';
	import ComputeAccounts from '#lib/components/nodes/compute-accounts.svelte';
	import NodePools from '#lib/components/nodes/node-pools.svelte';
	import PublicAccess from '#lib/components/nodes/public-access.svelte';
	import AlertList from '#lib/components/metrics/alert-list.svelte';
	import NodeMetrics from '#lib/components/metrics/node-metrics.svelte';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { reportError } from '#lib/forms.js';
	import { timeAgo } from '#lib/format.js';
	import { cn } from '#lib/utils.js';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import ServerIcon from '@lucide/svelte/icons/server';
	import type { Alert, NodeSummary, UpdateNode } from '@tramline/contracts';
	import { toast } from 'svelte-sonner';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// svelte-ignore state_referenced_locally
	let nodes = $state<NodeSummary[]>(data.nodes);
	// svelte-ignore state_referenced_locally
	let computeAccounts = $state(data.accounts);
	// svelte-ignore state_referenced_locally
	let provisioning = $state(data.provisioning);
	// svelte-ignore state_referenced_locally
	let publicAccess = $state(data.access);
	// svelte-ignore state_referenced_locally
	let nodePools = $state(data.pools);
	let alerts = $state<Alert[]>([]);
	/** Nodes whose charts are open. */
	let charted = $state<Record<string, boolean>>({});

	$effect(() => {
		// health and placement change without page events, so poll gently
		void loadAlerts();
		const timer = setInterval(refresh, 5_000);
		return () => clearInterval(timer);
	});

	async function refresh() {
		try {
			nodes = await api().nodes.getAll();
			// a machine that just enrolled leaves the provisioning list
			if (provisioning.length) provisioning = await api().adapters.provisioning();
			await loadAlerts();
		} catch {
			// keep showing the last list
		}
	}

	async function loadAlerts() {
		alerts = (
			await api()
				.metrics.alerts()
				.catch(() => alerts)
		).filter((a) => a.nodeId);
	}

	async function act(node: NodeSummary, action: 'cordon' | 'uncordon' | 'drain' | 'remove') {
		try {
			if (action === 'drain') {
				const result = await api().nodes.drain(node.id);
				const kept = result.kept.map((k) => k.service).join(', ');
				toast.success(
					`Moving ${result.moved} deployment${result.moved === 1 ? '' : 's'} off ${node.name}` +
						(kept ? `. Staying: ${kept} (data or pin on this node)` : '')
				);
			} else if (action === 'remove') {
				const machine = node.account ? ` Its machine on ${node.account.name} is destroyed.` : '';
				if (!confirm(`Remove ${node.name}? Its agent stops being able to connect.${machine}`))
					return;
				await api().nodes.remove(node.id);
				toast.success(`Removed ${node.name}`);
			} else {
				await api().nodes.update(node.id, { cordoned: action === 'cordon' });
			}
			await refresh();
		} catch (error) {
			reportError(error);
		}
	}

	async function configure(node: NodeSummary, input: UpdateNode) {
		try {
			await api().nodes.update(node.id, input);
			await refresh();
			return true;
		} catch (error) {
			reportError(error);
			return false;
		}
	}

	/** Nodes whose agent predates updates from here, showing the command that updates them once. */
	let manualUpdate = $state<Record<string, boolean>>({});

	/** A commit SHA reads better short. */
	const agentVersion = (version: string) =>
		/^[0-9a-f]{40}$/.test(version) ? version.slice(0, 7) : version;

	const updating = (node: NodeSummary) =>
		node.agent.update?.state === 'requested' || node.agent.update?.state === 'running';

	/** Only fresh outcomes are worth a line; old ones would sit there forever. */
	const recentlyFinished = (node: NodeSummary) =>
		!!node.agent.update?.finishedAt &&
		Date.now() - Date.parse(node.agent.update.finishedAt) < 3600_000 &&
		// the regular check finding nothing new isn't news
		!(
			node.agent.update.automatic &&
			node.agent.update.state === 'succeeded' &&
			node.agent.update.detail?.startsWith('Already up to date')
		);

	const updateCommand = () =>
		`curl -fsSL ${publicAccess?.agentUrl ?? location.origin}/install.sh | sudo sh -s -- --update`;

	async function updateAgent(node: NodeSummary) {
		if (!node.agent.canUpdate) {
			manualUpdate[node.id] = !manualUpdate[node.id];
			return;
		}
		if (
			!confirm(
				`Update ${node.name}'s agent to the latest image? If there's a newer one, the agent restarts on it. Its deployments keep running; the mesh and TCP proxies on it restart, which takes a few seconds.`
			)
		)
			return;
		try {
			const updated = await api().nodes.updateAgent(node.id);
			nodes = nodes.map((n) => (n.id === node.id ? updated : n));
		} catch (error) {
			reportError(error);
		}
	}

	/** Bumped to redraw a node's edge switch, undoing a flip that didn't happen. */
	let edgeSwitch = $state<Record<string, number>>({});

	async function setEdge(node: NodeSummary, edge: boolean) {
		const message =
			node.edgePorts === 'managed'
				? `Opens TCP 80 and 443 on ${node.name} to the internet. Only services with a public domain are reachable through them; everything else on the node stays private.`
				: `Serving public domains needs TCP 80 and 443 to reach ${node.name}; open them on your router or firewall.`;
		// turning it off needs no asking; on a managed node it closes the ports
		const done = (!edge || confirm(message)) && (await configure(node, { edge }));
		if (!done) edgeSwitch[node.id] = (edgeSwitch[node.id] ?? 0) + 1;
	}

	// svelte-ignore state_referenced_locally
	let admins = $state(data.admins);
	let setupToken = $state('');
	let adminEmail = $state('');

	async function claim(event: SubmitEvent) {
		event.preventDefault();
		try {
			await api().install.claim(setupToken);
			toast.success('You are now this install’s admin');
			await invalidateAll();
			admins = await api().install.admins();
		} catch (error) {
			reportError(error);
		}
	}

	async function grant(event: SubmitEvent) {
		event.preventDefault();
		try {
			admins = await api().install.grant(adminEmail);
			adminEmail = '';
		} catch (error) {
			reportError(error);
		}
	}

	async function revoke(userId: string) {
		try {
			admins = await api().install.revoke(userId);
		} catch (error) {
			reportError(error);
		}
	}

	const STATUS_DOT = { online: 'bg-emerald-400', offline: 'bg-zinc-500', error: 'bg-red-500' };
	const percent = (used: number, total: number | null) =>
		total ? Math.min(100, Math.round((used / total) * 100)) : 0;
	const cores = (n: number) => `${Math.round(n * 100) / 100} CPU${n === 1 ? '' : 's'}`;
	const gb = (mb: number) => `${(mb / 1024).toFixed(mb < 10_240 ? 1 : 0)} GB`;
</script>

<svelte:head><title>Nodes · Tramline</title></svelte:head>

<main class="mx-auto w-full max-w-3xl space-y-6 p-6">
	<div>
		<h1 class="text-xl font-semibold tracking-tight">Nodes</h1>
		<p class="text-sm text-muted-foreground">
			The machines your services run on. They're shared by every organization on this install.
		</p>
	</div>

	{#if data.awaitingSetup}
		<Card.Root data-testid="claim-install">
			<Card.Header>
				<Card.Title>Claim this install</Card.Title>
				<Card.Description>
					Nobody manages this install's nodes yet. The server wrote a one-time setup token to
					<code>setup-token</code> in its data directory (and said where in its log); paste it here to
					become the install admin.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form class="flex gap-2" onsubmit={claim}>
					<Input
						bind:value={setupToken}
						class="font-mono text-xs"
						placeholder="tlsetup_…"
						aria-label="Setup token"
						required
					/>
					<Button type="submit">Claim</Button>
				</form>
			</Card.Content>
		</Card.Root>
	{/if}

	{#if data.canManage}
		<AddNode accounts={computeAccounts} bind:provisioning access={publicAccess} />
		<NodePools accounts={computeAccounts} bind:pools={nodePools} />
		<ComputeAccounts adapters={data.adapters} bind:accounts={computeAccounts} />
		{#if publicAccess}
			<PublicAccess bind:access={publicAccess} nodes={data.nodes} />
		{/if}
	{/if}

	{#if data.canManage}
		<Card.Root data-testid="install-admins">
			<Card.Header>
				<Card.Title>Install admins</Card.Title>
				<Card.Description>
					They add, drain and remove nodes for every organization on this install.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-3">
				<ul class="divide-y rounded-lg border text-sm">
					{#each admins as admin (admin.userId)}
						<li class="flex items-center gap-3 px-3 py-2">
							<span class="font-medium">{admin.name}</span>
							<span class="text-xs text-muted-foreground">{admin.email}</span>
							{#if admins.length > 1}
								<Button
									class="ml-auto"
									size="sm"
									variant="ghost"
									onclick={() => revoke(admin.userId)}>Remove</Button
								>
							{/if}
						</li>
					{/each}
				</ul>
				<form class="flex gap-2" onsubmit={grant}>
					<Input
						type="email"
						bind:value={adminEmail}
						placeholder="Email of someone with an account"
						aria-label="New admin's email"
						required
					/>
					<Button type="submit" variant="outline">Add admin</Button>
				</form>
			</Card.Content>
		</Card.Root>
	{/if}

	<AlertList {alerts} />

	<ul class="space-y-3" data-testid="node-list">
		{#each nodes as node (node.id)}
			<li class="rounded-xl border bg-card p-4" data-testid="node-row" data-node={node.name}>
				<div class="flex flex-wrap items-center gap-3">
					<ServerIcon class="size-4 text-muted-foreground" />
					<span class="font-medium">{node.name}</span>
					<span class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<span class={cn('size-2 rounded-full', STATUS_DOT[node.status])}></span>
						{node.status}
					</span>
					{#if node.draining}
						<Badge variant="secondary">Draining</Badge>
					{:else if node.cordoned}
						<Badge variant="secondary">Cordoned</Badge>
					{/if}
					{#if node.edge}<Badge variant="outline">Edge</Badge>{/if}
					{#if node.pool}<Badge variant="outline">Pool {node.pool.name}</Badge>{/if}
					<span class="ml-auto text-xs text-muted-foreground">
						{node.deployments} deployment{node.deployments === 1 ? '' : 's'}
					</span>
				</div>
				<div class="mt-2 text-xs text-muted-foreground">
					{node.hostname ?? 'not connected yet'}
					{#if node.cpus}· {node.cpus} CPUs{/if}
					{#if node.memoryMb}· {gb(node.memoryMb)}{/if}
					{#if node.gpus.length}· {node.gpus.length}× {node.gpus[0]!.model}{node.gpus[0]!.vramMb
							? ` ${Math.round(node.gpus[0]!.vramMb / 1024)} GB`
							: ''}{#if node.gpuRuntime}, {node.allocatedGpus} in use{/if}{/if}
					{#if node.dockerVersion}· Docker {node.dockerVersion}{/if}
					{#if node.agent.version}· agent {agentVersion(node.agent.version)}{/if}
					{#if node.account}· on {node.account.name}{/if}
					{#if node.lastSeenAt && node.status !== 'online'}· last seen {timeAgo(
							node.lastSeenAt
						)}{/if}
				</div>
				{#if node.error}<p class="mt-1 text-xs text-red-400">{node.error}</p>{/if}
				{#if node.status === 'online' && node.containment && node.containment.state !== 'active' && node.containment.state !== 'starting'}
					<p class="mt-1 text-xs text-amber-600 dark:text-amber-400" data-testid="not-contained">
						Service containers here aren't contained, so they can reach the LAN, the mesh and the
						node itself. {node.containment.detail ?? ''}
					</p>
				{/if}
				{#if node.gpus.length && !node.gpuRuntime && node.status === 'online'}
					<p class="mt-1 text-xs text-amber-600 dark:text-amber-400" data-testid="no-gpu-runtime">
						This node has GPUs, but Docker can't hand them to containers, so no GPU work runs here.
						Install the NVIDIA container toolkit and run
						<code>sudo nvidia-ctk runtime configure --runtime=docker</code>, then restart Docker.
					</p>
				{/if}
				{#if updating(node)}
					<p
						class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"
						data-testid="agent-update"
					>
						<Loader2Icon class="size-3 animate-spin" />
						Updating the agent{node.agent.update?.detail ? `: ${node.agent.update.detail}` : '…'}
					</p>
				{:else if recentlyFinished(node) && node.agent.update?.state === 'failed'}
					<p class="mt-1 text-xs text-red-400" data-testid="agent-update">
						Agent update failed: {node.agent.update.error}
					</p>
				{:else if recentlyFinished(node) && node.agent.update?.state === 'succeeded'}
					<p class="mt-1 text-xs text-muted-foreground" data-testid="agent-update">
						Agent: {node.agent.update.detail ?? 'updated'}
					</p>
				{/if}
				{#if node.mesh}
					<div class="mt-1 text-xs text-muted-foreground" data-testid="node-mesh">
						Mesh {node.mesh.address} ·
						{node.mesh.endpoint ? `reachable at ${node.mesh.endpoint}` : 'behind NAT'}
						{#each node.mesh.relayed as r (r.node)}· reaches {r.node} via {r.via}{/each}
					</div>
					{#if node.mesh.unreachable.length}
						<p class="mt-1 text-xs text-amber-400">
							Can't reach {node.mesh.unreachable.join(', ')}: neither side has a public address, and
							no node can relay. Give one of them a mesh endpoint.
						</p>
					{/if}
				{/if}
				{#if node.memoryMb || node.cpus}
					<div class="mt-3 grid gap-3 sm:grid-cols-2" data-testid="node-reserved">
						{#if node.memoryMb}
							<div class="space-y-1">
								<div class="h-1.5 overflow-hidden rounded-full bg-muted">
									<div
										class="h-full bg-foreground/60"
										style="width: {percent(node.allocatedMemoryMb, node.memoryMb)}%"
									></div>
								</div>
								<div class="text-xs text-muted-foreground">
									Memory: {gb(node.allocatedMemoryMb)} of {gb(node.memoryMb)} reserved
								</div>
							</div>
						{/if}
						{#if node.cpus}
							<div class="space-y-1">
								<div class="h-1.5 overflow-hidden rounded-full bg-muted">
									<div
										class="h-full bg-foreground/60"
										style="width: {percent(node.allocatedCpus, node.cpus)}%"
									></div>
								</div>
								<div class="text-xs text-muted-foreground">
									CPU: {cores(node.allocatedCpus)} of {cores(node.cpus)} reserved
								</div>
							</div>
						{/if}
					</div>
				{/if}
				<div class="mt-3">
					<button
						type="button"
						class="text-xs text-muted-foreground underline-offset-2 hover:underline"
						aria-expanded={!!charted[node.id]}
						onclick={() => (charted[node.id] = !charted[node.id])}
						>{charted[node.id] ? 'Hide metrics' : 'Show metrics'}</button
					>
					{#if charted[node.id]}
						<div class="mt-2"><NodeMetrics nodeId={node.id} /></div>
					{/if}
				</div>
				{#if data.canManage}
					<div class="mt-3 flex flex-wrap gap-2">
						{#if node.cordoned}
							<Button size="sm" variant="outline" onclick={() => act(node, 'uncordon')}
								>Uncordon</Button
							>
						{:else}
							<Button size="sm" variant="outline" onclick={() => act(node, 'cordon')}>Cordon</Button
							>
						{/if}
						{#if !node.draining}
							<Button size="sm" variant="outline" onclick={() => act(node, 'drain')}>Drain</Button>
						{/if}
						{#if node.agent.version && node.status !== 'offline' && (node.agent.canUpdate || node.name !== 'local')}
							<Button
								size="sm"
								variant="outline"
								disabled={updating(node)}
								onclick={() => updateAgent(node)}>Update agent</Button
							>
						{/if}
						{#if node.name !== 'local'}
							<Button size="sm" variant="ghost" onclick={() => act(node, 'remove')}>Remove</Button>
						{/if}
					</div>
					{#if manualUpdate[node.id] && !node.agent.canUpdate}
						<div class="mt-3 space-y-2 rounded-lg border p-3 text-xs" data-testid="manual-update">
							<p>
								This agent is from before updates from here (or doesn't run in a container). Run
								this once on {node.name}; it keeps the node's identity and settings, and later
								updates work from this page.
							</p>
							<div class="flex items-center gap-2">
								<code class="flex-1 overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono"
									>{updateCommand()}</code
								>
								<Button
									size="sm"
									variant="outline"
									onclick={() =>
										navigator.clipboard
											.writeText(updateCommand())
											.then(() => toast.success('Copied'))}>Copy</Button
								>
							</div>
						</div>
					{/if}
					<div class="mt-3 flex flex-wrap items-center gap-4 text-sm">
						<label class="flex items-center gap-2">
							{#key edgeSwitch[node.id]}
								<Switch
									checked={node.edge}
									onCheckedChange={(edge) => setEdge(node, edge)}
									aria-label="Edge node"
								/>
							{/key}
							Edge: serve every public domain
						</label>
						<form
							class="flex items-center gap-2"
							onsubmit={(event) => {
								event.preventDefault();
								const value = new FormData(event.currentTarget).get('endpoint');
								configure(node, { meshEndpoint: String(value ?? '').trim() || null });
							}}
						>
							<Input
								name="endpoint"
								class="h-8 w-56 font-mono text-xs"
								placeholder="Mesh endpoint, e.g. 203.0.113.7:51820"
								aria-label="Mesh endpoint"
								value={node.mesh?.endpoint ?? ''}
							/>
							<Button size="sm" variant="outline" type="submit">Save</Button>
						</form>
					</div>
				{/if}
			</li>
		{/each}
	</ul>
</main>
