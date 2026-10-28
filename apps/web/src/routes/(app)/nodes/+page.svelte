<script lang="ts">
	import { api } from '#lib/api.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { reportError } from '#lib/forms.js';
	import { timeAgo } from '#lib/format.js';
	import { cn } from '#lib/utils.js';
	import ServerIcon from '@lucide/svelte/icons/server';
	import type { CreatedJoinToken, NodeSummary } from '@tramline/contracts';
	import { toast } from 'svelte-sonner';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// svelte-ignore state_referenced_locally
	let nodes = $state<NodeSummary[]>(data.nodes);
	let name = $state('');
	let startCordoned = $state(false);
	let joining = $state<CreatedJoinToken | null>(null);

	$effect(() => {
		// health and placement change without page events, so poll gently
		const timer = setInterval(refresh, 5_000);
		return () => clearInterval(timer);
	});

	async function refresh() {
		try {
			nodes = await api().nodes.getAll();
		} catch {
			// keep showing the last list
		}
	}

	async function add(event: SubmitEvent) {
		event.preventDefault();
		try {
			joining = await api().nodes.join({ name: name.trim(), cordoned: startCordoned });
			name = '';
		} catch (error) {
			reportError(error);
		}
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
				if (!confirm(`Remove ${node.name}? Its agent stops being able to connect.`)) return;
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

	const STATUS_DOT = { online: 'bg-emerald-400', offline: 'bg-zinc-500', error: 'bg-red-500' };
	const percent = (n: NodeSummary) =>
		n.memoryMb ? Math.min(100, Math.round((n.allocatedMemoryMb / n.memoryMb) * 100)) : 0;
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

	{#if data.canManage}
		<Card.Root data-testid="add-node">
			<Card.Header>
				<Card.Title>Add a node</Card.Title>
				<Card.Description>
					Any Linux machine with Docker: a VM, a VPS, a spare box. Run the command on it as root.
					The agent connects out to Tramline, so the machine needs no open ports for it.
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
									navigator.clipboard
										.writeText(joining!.command)
										.then(() => toast.success('Copied'))}>Copy</Button
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
					<Field.Field class="min-w-48 flex-1">
						<Field.Label for="node-name">Name</Field.Label>
						<Input id="node-name" placeholder="hetzner-1" bind:value={name} required />
					</Field.Field>
					<label class="flex h-9 items-center gap-2 text-sm">
						<Switch bind:checked={startCordoned} aria-label="Start cordoned" />
						Start cordoned
					</label>
					<Button type="submit">Create join command</Button>
				</form>
			</Card.Content>
		</Card.Root>
	{/if}

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
					<span class="ml-auto text-xs text-muted-foreground">
						{node.deployments} deployment{node.deployments === 1 ? '' : 's'}
					</span>
				</div>
				<div class="mt-2 text-xs text-muted-foreground">
					{node.hostname ?? 'not connected yet'}
					{#if node.cpus}· {node.cpus} CPUs{/if}
					{#if node.memoryMb}· {gb(node.memoryMb)}{/if}
					{#if node.dockerVersion}· Docker {node.dockerVersion}{/if}
					{#if node.lastSeenAt && node.status !== 'online'}· last seen {timeAgo(
							node.lastSeenAt
						)}{/if}
				</div>
				{#if node.error}<p class="mt-1 text-xs text-red-400">{node.error}</p>{/if}
				{#if node.memoryMb}
					<div class="mt-3 space-y-1">
						<div class="h-1.5 overflow-hidden rounded-full bg-muted">
							<div class="h-full bg-foreground/60" style="width: {percent(node)}%"></div>
						</div>
						<div class="text-xs text-muted-foreground">
							{gb(node.allocatedMemoryMb)} of {gb(node.memoryMb)} reserved by memory limits
						</div>
					</div>
				{/if}
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
						{#if node.name !== 'local'}
							<Button size="sm" variant="ghost" onclick={() => act(node, 'remove')}>Remove</Button>
						{/if}
					</div>
				{/if}
			</li>
		{/each}
	</ul>
</main>
