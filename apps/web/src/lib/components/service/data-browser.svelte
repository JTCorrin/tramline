<script lang="ts">
	import { api } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { reportError } from '#lib/forms.js';
	import { cn } from '#lib/utils.js';
	import type { DataRows, DataTable } from '@tramline/contracts';

	let { serviceId, environmentId }: { serviceId: string; environmentId: string } = $props();

	const client = api();
	let tables = $state<DataTable[]>();
	let error = $state<string | null>(null);
	let selected = $state<DataTable | null>(null);
	let page = $state<DataRows | null>(null);
	let loading = $state(false);

	const label = (t: DataTable) => (t.schema === 'public' ? t.name : `${t.schema}.${t.name}`);
	const cell = (value: unknown) =>
		value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);

	function load() {
		client.data
			.tables({ serviceId, environmentId })
			.then((list) => {
				tables = list;
				error = null;
			})
			.catch((e: Error) => (error = e.message));
	}

	$effect(load);

	async function open(table: DataTable, offset = 0) {
		selected = table;
		loading = true;
		try {
			page = await client.data.rows({
				serviceId,
				environmentId,
				schema: table.schema,
				table: table.name,
				offset
			});
		} catch (e) {
			reportError(e);
		} finally {
			loading = false;
		}
	}
</script>

<div class="space-y-3" data-testid="data-browser">
	<div class="flex items-center gap-2">
		<p class="flex-1 text-xs text-muted-foreground">
			Read-only: every query runs in a read-only transaction inside the database, with a 5 second
			limit.
		</p>
		<Button
			variant="ghost"
			size="sm"
			onclick={() => {
				load();
				if (selected) void open(selected, page?.offset ?? 0);
			}}>Refresh</Button
		>
	</div>
	{#if error}
		<div class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
			{error}
		</div>
	{:else if !tables}
		<p class="text-sm text-muted-foreground">Loading tables…</p>
	{:else if !tables.length}
		<div class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
			No tables yet.
		</div>
	{:else}
		<div class="flex flex-wrap gap-1.5" data-testid="data-tables">
			{#each tables as table (`${table.schema}.${table.name}`)}
				<button
					type="button"
					class={cn(
						'rounded-md border px-2 py-1 font-mono text-xs hover:bg-accent',
						selected === table && 'border-foreground/60 bg-accent'
					)}
					onclick={() => open(table)}
				>
					{label(table)}
					{#if table.estimate >= 0}<span class="text-muted-foreground">~{table.estimate}</span>{/if}
				</button>
			{/each}
		</div>
		{#if page && selected}
			<div class="overflow-auto rounded-md border" data-testid="data-rows">
				<table class="w-full text-left font-mono text-xs">
					<thead class="sticky top-0 bg-muted/60">
						<tr>
							{#each page.columns as column (column)}
								<th class="px-2 py-1.5 font-medium whitespace-nowrap">{column}</th>
							{/each}
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each page.rows as row, i (i)}
							<tr>
								{#each page.columns as column (column)}
									<td
										class={cn(
											'max-w-64 truncate px-2 py-1',
											row[column] === null && 'text-muted-foreground'
										)}
										title={cell(row[column])}>{cell(row[column])}</td
									>
								{/each}
							</tr>
						{:else}
							<tr><td class="px-2 py-3 text-muted-foreground">No rows.</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
			<div class="flex items-center justify-between text-xs text-muted-foreground">
				<span>
					{#if page.rows.length}Rows {page.offset + 1}–{page.offset + page.rows.length}{/if}
				</span>
				<div class="flex gap-2">
					<Button
						variant="outline"
						size="sm"
						disabled={loading || page.offset === 0}
						onclick={() => open(selected!, Math.max(0, page!.offset - 50))}>Previous</Button
					>
					<Button
						variant="outline"
						size="sm"
						disabled={loading || !page.hasMore}
						onclick={() => open(selected!, page!.offset + 50)}>Next</Button
					>
				</div>
			</div>
		{/if}
	{/if}
</div>
