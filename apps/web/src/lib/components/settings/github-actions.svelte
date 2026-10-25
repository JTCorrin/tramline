<script lang="ts">
	import { api } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { reportError } from '#lib/forms.js';
	import { timeAgo } from '#lib/format.js';
	import { TOKEN_SCOPES, type OidcTrust, type TokenScope } from '@tramline/contracts';
	import { toast } from 'svelte-sonner';

	let { rules: initial, audience }: { rules: OidcTrust[]; audience: string | null } = $props();

	// svelte-ignore state_referenced_locally
	let rules = $state(initial);
	let repository = $state('');
	let refPattern = $state('refs/heads/main');
	let environment = $state('');
	let scopes = $state<Record<TokenScope, boolean>>({ read: false, write: false, deploy: true });

	const example = $derived(`permissions:
  id-token: write
steps:
  - name: Deploy to Tramline
    run: |
      JWT=$(curl -sSfH "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\
        "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=${audience ?? 'https://<tramline>'}" | jq -r .value)
      TOKEN=$(curl -sSf -X POST ${audience ?? 'https://<tramline>'}/api/v1/oidc/github \\
        -H 'content-type: application/json' -d "{\\"token\\":\\"$JWT\\"}" | jq -r .token)
      curl -sSf -X POST ${audience ?? 'https://<tramline>'}/api/v1/services/<service id>/deploy \\
        -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
        -d "{\\"environmentId\\":\\"<environment id>\\",\\"commit\\":\\"$GITHUB_SHA\\"}"`);

	async function add(event: SubmitEvent) {
		event.preventDefault();
		try {
			const rule = await api().oidc.createTrust({
				repository,
				refPattern: refPattern.trim() || null,
				environment: environment.trim() || null,
				scopes: TOKEN_SCOPES.filter((s) => scopes[s])
			});
			rules = [rule, ...rules];
			repository = '';
			toast.success(`${rule.repository} can now deploy`);
		} catch (error) {
			reportError(error);
		}
	}

	async function remove(rule: OidcTrust) {
		try {
			await api().oidc.removeTrust(rule.id);
			rules = rules.filter((r) => r.id !== rule.id);
		} catch (error) {
			reportError(error);
		}
	}
</script>

<Card.Root data-testid="github-actions">
	<Card.Header>
		<Card.Title>GitHub Actions</Card.Title>
		<Card.Description>
			Let workflows in a repository deploy without a stored secret: the workflow trades its GitHub
			OIDC token for a Tramline token that lasts 15 minutes.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		{#if !audience}
			<p class="text-sm text-muted-foreground">
				Set <code class="font-mono">TRAMLINE_URL</code> first: workflows request tokens for this install’s
				address.
			</p>
		{/if}
		<form class="space-y-3" onsubmit={add}>
			<div class="grid gap-3 sm:grid-cols-3">
				<Field.Field>
					<Field.Label for="oidc-repo">Repository</Field.Label>
					<Input id="oidc-repo" placeholder="acme/api" bind:value={repository} required />
				</Field.Field>
				<Field.Field>
					<Field.Label for="oidc-ref">Ref</Field.Label>
					<Input id="oidc-ref" placeholder="Any ref" bind:value={refPattern} class="font-mono" />
				</Field.Field>
				<Field.Field>
					<Field.Label for="oidc-env">GitHub environment</Field.Label>
					<Input id="oidc-env" placeholder="Any" bind:value={environment} />
				</Field.Field>
			</div>
			<div class="flex flex-wrap gap-4">
				{#each TOKEN_SCOPES as scope (scope)}
					<label class="flex items-center gap-2 text-sm">
						<Switch bind:checked={scopes[scope]} aria-label="Trust scope {scope}" />
						<span class="font-mono">{scope}</span>
					</label>
				{/each}
			</div>
			<Button type="submit">Trust repository</Button>
		</form>
		{#if rules.length}
			<ul class="divide-y rounded-lg border text-sm" data-testid="trust-rules">
				{#each rules as rule (rule.id)}
					<li class="flex items-center gap-3 px-3 py-2">
						<div class="min-w-0 flex-1">
							<div class="font-mono">
								{rule.repository}{rule.refPattern ? ` · ${rule.refPattern}` : ''}{rule.environment
									? ` · ${rule.environment}`
									: ''}
							</div>
							<div class="text-xs text-muted-foreground">
								{rule.scopes.join(', ')} ·
								{rule.lastUsedAt ? `used ${timeAgo(rule.lastUsedAt)}` : 'never used'}
								{#if rule.repositoryId}· pinned to repository #{rule.repositoryId}{/if}
							</div>
						</div>
						<Button variant="ghost" size="sm" onclick={() => remove(rule)}>Remove</Button>
					</li>
				{/each}
			</ul>
		{/if}
		<details class="text-sm">
			<summary class="cursor-pointer text-muted-foreground">Example workflow step</summary>
			<pre class="mt-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{example}</pre>
		</details>
	</Card.Content>
</Card.Root>
