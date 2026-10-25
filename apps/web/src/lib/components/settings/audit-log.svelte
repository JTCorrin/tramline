<script lang="ts">
	import * as Card from '#lib/components/ui/card/index.js';
	import { timeAgo } from '#lib/format.js';
	import type { AuditEvent } from '@tramline/contracts';

	let { events }: { events: AuditEvent[] } = $props();
</script>

<Card.Root data-testid="audit-log">
	<Card.Header>
		<Card.Title>Audit log</Card.Title>
		<Card.Description>
			Every change made through Tramline in the last 90 days, by a person or an API token.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if events.length}
			<div class="max-h-96 overflow-auto rounded-md border">
				<table class="w-full text-left text-xs">
					<thead class="sticky top-0 bg-muted/60 text-muted-foreground">
						<tr>
							<th class="px-3 py-1.5 font-medium">When</th>
							<th class="px-3 py-1.5 font-medium">Who</th>
							<th class="px-3 py-1.5 font-medium">What</th>
							<th class="px-3 py-1.5 font-medium">Result</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each events as event (event.id)}
							<tr>
								<td class="px-3 py-1.5 whitespace-nowrap text-muted-foreground"
									>{timeAgo(event.createdAt)}</td
								>
								<td class="px-3 py-1.5">
									{event.user?.name ?? 'Someone'}{#if event.token}
										<span class="text-muted-foreground"> via token “{event.token.name}”</span>{/if}
								</td>
								<td class="px-3 py-1.5 font-mono" title={JSON.stringify(event.params)}
									>{event.action}</td
								>
								<td
									class="px-3 py-1.5 {event.status < 400
										? 'text-muted-foreground'
										: 'text-destructive'}">{event.status}</td
								>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<p class="text-sm text-muted-foreground">No changes yet.</p>
		{/if}
	</Card.Content>
</Card.Root>
