<script lang="ts">
	import { api } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { reportError } from '#lib/forms.js';
	import { cn } from '#lib/utils.js';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import Undo2Icon from '@lucide/svelte/icons/undo-2';
	import { VARIABLE_KEY, type Variable } from '@tramline/contracts';
	import { SvelteSet } from 'svelte/reactivity';
	import ReferenceInput from './reference-input.svelte';

	let {
		environmentId,
		serviceId,
		version,
		suggestions
	}: {
		environmentId: string;
		/** null for the environment's shared variables */
		serviceId: string | null;
		/** bump to refetch */
		version: number;
		suggestions: string[];
	} = $props();

	const client = api();
	let variables = $state<Variable[]>([]);
	let loaded = $state(false);
	const revealed = new SvelteSet<string>();
	let editing = $state<string | null>(null);
	let editValue = $state('');
	let newKey = $state('');
	let newValue = $state('');
	let raw = $state<string | null>(null);

	$effect(() => {
		void version;
		client.variables
			.getAll({ environmentId, ...(serviceId ? { serviceId } : {}) })
			.then((list) => {
				variables = list;
				loaded = true;
			})
			.catch(reportError);
	});

	async function stage(set: Record<string, string>, unset: string[] = []) {
		try {
			variables = await client.variables.stage({ environmentId, serviceId, set, unset });
		} catch (error) {
			reportError(error);
		}
	}

	async function add(event: SubmitEvent) {
		event.preventDefault();
		await stage({ [newKey.trim()]: newValue });
		newKey = newValue = '';
	}

	function toggle(key: string) {
		if (revealed.has(key)) revealed.delete(key);
		else revealed.add(key);
	}

	const toRaw = () =>
		variables
			.filter((v) => v.staged !== 'removed')
			.map((v) => `${v.key}=${v.value}`)
			.join('\n');

	async function saveRaw() {
		const next: Record<string, string> = {};
		for (const line of (raw ?? '').split('\n')) {
			const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
			if (match) next[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
		}
		const current = variables.filter((v) => v.staged !== 'removed');
		const set = Object.fromEntries(
			Object.entries(next).filter(
				([key, value]) => current.find((v) => v.key === key)?.value !== value
			)
		);
		const unset = current.filter((v) => !(v.key in next)).map((v) => v.key);
		await stage(set, unset);
		raw = null;
	}

	const BADGE: Record<NonNullable<Variable['staged']>, string> = {
		added: 'text-emerald-400',
		modified: 'text-amber-400',
		removed: 'text-red-400 line-through'
	};
	const validNewKey = $derived(VARIABLE_KEY.test(newKey.trim()));
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<p class="text-xs text-muted-foreground">
			{variables.length}
			{variables.length === 1 ? 'variable' : 'variables'} · type
			<code class="font-mono">&#36;&#123;&#123;</code> to reference another
		</p>
		<Button variant="outline" size="sm" onclick={() => (raw = raw === null ? toRaw() : null)}>
			{raw === null ? 'Raw editor' : 'Table view'}
		</Button>
	</div>

	{#if raw !== null}
		<Textarea class="min-h-64 font-mono text-xs" bind:value={raw} spellcheck={false} />
		<div class="flex justify-end gap-2">
			<Button variant="ghost" size="sm" onclick={() => (raw = null)}>Cancel</Button>
			<Button size="sm" onclick={saveRaw}>Stage changes</Button>
		</div>
	{:else}
		<form class="flex gap-2" onsubmit={add}>
			<Input
				class="w-2/5 font-mono text-xs"
				placeholder="KEY"
				aria-label="New variable key"
				bind:value={newKey}
			/>
			<div class="flex-1">
				<ReferenceInput
					placeholder="value or &#36;&#123;&#123;Service.KEY&#125;&#125;"
					aria-label="New variable value"
					{suggestions}
					bind:value={newValue}
				/>
			</div>
			<Button type="submit" size="sm" disabled={!validNewKey}>Add</Button>
		</form>

		{#if loaded && variables.length === 0}
			<p class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
				No variables yet.
			</p>
		{/if}

		<ul class="divide-y rounded-lg border" data-testid="variables">
			{#each variables as variable (variable.key)}
				<li class="group flex items-center gap-2 px-3 py-2">
					<span
						class={cn(
							'w-2/5 truncate font-mono text-xs',
							variable.staged && BADGE[variable.staged]
						)}
						title={variable.staged ? `${variable.staged}, not deployed yet` : undefined}
					>
						{variable.key}
					</span>
					{#if editing === variable.key}
						<form
							class="flex flex-1 gap-2"
							onsubmit={async (event) => {
								event.preventDefault();
								await stage({ [variable.key]: editValue });
								editing = null;
							}}
						>
							<div class="flex-1">
								<ReferenceInput
									aria-label="Value of {variable.key}"
									{suggestions}
									bind:value={editValue}
									onkeydown={(event) => event.key === 'Escape' && (editing = null)}
								/>
							</div>
							<Button type="submit" size="sm">Save</Button>
						</form>
					{:else}
						<span class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
							{revealed.has(variable.key) ? variable.value : '••••••••'}
						</span>
						<div class="flex opacity-60 group-hover:opacity-100">
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="{revealed.has(variable.key) ? 'Hide' : 'Show'} {variable.key}"
								onclick={() => toggle(variable.key)}
							>
								{#if revealed.has(variable.key)}<EyeOffIcon />{:else}<EyeIcon />{/if}
							</Button>
							{#if variable.staged === 'removed'}
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Restore {variable.key}"
									onclick={() => stage({ [variable.key]: variable.value })}
								>
									<Undo2Icon />
								</Button>
							{:else}
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Edit {variable.key}"
									onclick={() => {
										editing = variable.key;
										editValue = variable.value;
									}}
								>
									<PencilIcon />
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Delete {variable.key}"
									onclick={() => stage({}, [variable.key])}
								>
									<TrashIcon />
								</Button>
							{/if}
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
