<script lang="ts">
	import { cn } from '#lib/utils.js';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import ShieldQuestionIcon from '@lucide/svelte/icons/shield-question';
	import { SEVERITIES, type ScanResult, type Severity } from '@tramline/contracts';

	/** One summary line, or with `details` the table of findings. */
	let { scan, details = false }: { scan: ScanResult; details?: boolean } = $props();

	const TONE: Record<ScanResult['outcome'], string> = {
		clean: 'text-emerald-600 dark:text-emerald-400',
		warned: 'text-amber-600 dark:text-amber-400',
		blocked: 'text-destructive',
		error: 'text-muted-foreground'
	};
	const SEVERITY_TONE: Record<Severity, string> = {
		critical: 'bg-destructive/15 text-destructive',
		high: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
		medium: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-300',
		low: 'bg-muted text-muted-foreground',
		unknown: 'bg-muted text-muted-foreground'
	};

	const summary = $derived.by(() => {
		if (scan.outcome === 'error') return `Scan failed: ${scan.error}`;
		const found = SEVERITIES.filter((s) => s === 'critical' || s === 'high')
			.filter((s) => scan.counts[s] > 0)
			.map((s) => `${scan.counts[s]} ${s}`);
		if (!found.length) return 'No high or critical vulnerabilities';
		const fixable = scan.fixableCritical ? ` (${scan.fixableCritical} critical fixable)` : '';
		return `${found.join(', ')}${fixable}${scan.outcome === 'blocked' ? ', blocked' : ''}`;
	});

	const link = (id: string) =>
		id.startsWith('GHSA-')
			? `https://github.com/advisories/${id}`
			: `https://avd.aquasec.com/nvd/${id.toLowerCase()}`;
</script>

{#if !details}
	<div
		class={cn('flex items-center gap-1 text-xs', TONE[scan.outcome])}
		title="{scan.scanner}, {new Date(scan.scannedAt).toLocaleString()}"
		data-testid="scan-summary"
	>
		{#if scan.outcome === 'clean'}
			<ShieldCheckIcon class="size-3.5 shrink-0" />
		{:else if scan.outcome === 'error'}
			<ShieldQuestionIcon class="size-3.5 shrink-0" />
		{:else}
			<ShieldAlertIcon class="size-3.5 shrink-0" />
		{/if}
		<span class="truncate">{summary}</span>
	</div>
{:else if scan.findings.length}
	<div class="overflow-hidden rounded-md border" data-testid="scan-findings">
		<div class="flex flex-wrap gap-1.5 border-b bg-muted/40 px-3 py-2 text-xs">
			{#each SEVERITIES as severity (severity)}
				{#if scan.counts[severity]}
					<span class={cn('rounded px-1.5 py-0.5 font-medium', SEVERITY_TONE[severity])}>
						{scan.counts[severity]}
						{severity}
					</span>
				{/if}
			{/each}
			<span class="ml-auto text-muted-foreground">{scan.scanner}</span>
		</div>
		<div class="max-h-64 overflow-auto">
			<table class="w-full text-left text-xs">
				<thead class="sticky top-0 bg-background text-muted-foreground">
					<tr>
						<th class="px-3 py-1.5 font-medium">Vulnerability</th>
						<th class="px-3 py-1.5 font-medium">Package</th>
						<th class="px-3 py-1.5 font-medium">Installed</th>
						<th class="px-3 py-1.5 font-medium">Fixed in</th>
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each scan.findings as finding (`${finding.id}|${finding.package}|${finding.installed}`)}
						<tr>
							<td class="px-3 py-1.5">
								<span
									class={cn(
										'mr-1.5 inline-block w-14 rounded px-1 text-center text-[10px] font-medium uppercase',
										SEVERITY_TONE[finding.severity]
									)}>{finding.severity}</span
								>
								<a
									href={link(finding.id)}
									target="_blank"
									rel="external noopener noreferrer"
									class="font-mono hover:underline"
									title={finding.title ?? undefined}>{finding.id}</a
								>
							</td>
							<td class="px-3 py-1.5 font-mono">{finding.package}</td>
							<td class="px-3 py-1.5 font-mono text-muted-foreground">{finding.installed}</td>
							<td class="px-3 py-1.5 font-mono">{finding.fixed ?? '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if scan.findings.length < SEVERITIES.reduce((n, s) => n + scan.counts[s], 0)}
			<p class="border-t px-3 py-1.5 text-xs text-muted-foreground">
				Showing the {scan.findings.length} most severe; the build log has the scan output.
			</p>
		{/if}
	</div>
{/if}
