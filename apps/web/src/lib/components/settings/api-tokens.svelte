<script lang="ts">
	import { api } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { reportError } from '#lib/forms.js';
	import { timeAgo } from '#lib/format.js';
	import { TOKEN_SCOPES, type ApiToken, type TokenScope } from '@tramline/contracts';
	import { toast } from 'svelte-sonner';

	let { tokens: initial }: { tokens: ApiToken[] } = $props();

	// svelte-ignore state_referenced_locally
	let tokens = $state(initial);
	let name = $state('');
	let scopes = $state<Record<TokenScope, boolean>>({ read: true, write: false, deploy: false });
	let expiry = $state('90');
	let created = $state<string | null>(null);

	const SCOPE_HELP: Record<TokenScope, string> = {
		read: 'See projects, services, deployments and logs',
		write: 'Stage changes: services, config and variables',
		deploy: 'Apply changes and delete: deploy, redeploy, restore, run and delete'
	};
	const EXPIRY: Record<string, string> = {
		'30': '30 days',
		'90': '90 days',
		'365': '1 year',
		never: 'Never'
	};

	async function create(event: SubmitEvent) {
		event.preventDefault();
		try {
			const token = await api().tokens.create({
				name,
				scopes: TOKEN_SCOPES.filter((s) => scopes[s]),
				expiresInDays: expiry === 'never' ? null : Number(expiry)
			});
			created = token.token;
			// the list never holds the secret
			tokens = [{ ...token, token: undefined } as ApiToken, ...tokens];
			name = '';
		} catch (error) {
			reportError(error);
		}
	}

	async function revoke(token: ApiToken) {
		try {
			await api().tokens.revoke(token.id);
			tokens = tokens.filter((t) => t.id !== token.id);
			toast.success(`Revoked ${token.name}`);
		} catch (error) {
			reportError(error);
		}
	}
</script>

<Card.Root data-testid="api-tokens">
	<Card.Header>
		<Card.Title>API tokens</Card.Title>
		<Card.Description>
			For scripts, CI and AI agents (the Tramline MCP server). A token acts as you in this
			organization, limited to its scopes, and can't manage tokens or settings.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		{#if created}
			<div class="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
				<p class="font-medium">Copy your token now; it won't be shown again.</p>
				<div class="flex gap-2">
					<Input readonly value={created} class="font-mono text-xs" data-testid="new-token" />
					<Button
						variant="outline"
						onclick={() =>
							navigator.clipboard.writeText(created!).then(() => toast.success('Copied'))}
						>Copy</Button
					>
				</div>
				<Button variant="ghost" size="sm" onclick={() => (created = null)}>Done</Button>
			</div>
		{/if}
		<form class="space-y-3" onsubmit={create}>
			<div class="grid gap-3 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="token-name">Name</Field.Label>
					<Input id="token-name" placeholder="GitHub Actions" bind:value={name} required />
				</Field.Field>
				<Field.Field>
					<Field.Label>Expires</Field.Label>
					<Select.Root type="single" bind:value={expiry}>
						<Select.Trigger class="w-full" aria-label="Expires">{EXPIRY[expiry]}</Select.Trigger>
						<Select.Content>
							{#each Object.entries(EXPIRY) as [value, label] (value)}
								<Select.Item {value}>{label}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</Field.Field>
			</div>
			<div class="space-y-2">
				{#each TOKEN_SCOPES as scope (scope)}
					<label class="flex items-center gap-3 text-sm">
						<Switch bind:checked={scopes[scope]} aria-label="Scope {scope}" />
						<span class="font-mono">{scope}</span>
						<span class="text-xs text-muted-foreground">{SCOPE_HELP[scope]}</span>
					</label>
				{/each}
			</div>
			<Button type="submit">Create token</Button>
		</form>
		{#if tokens.length}
			<ul class="divide-y rounded-lg border text-sm" data-testid="token-list">
				{#each tokens as token (token.id)}
					<li class="flex items-center gap-3 px-3 py-2">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="font-medium">{token.name}</span>
								<code class="text-xs text-muted-foreground">{token.prefix}…</code>
							</div>
							<div class="text-xs text-muted-foreground">
								{token.scopes.join(', ')} · {token.createdBy.name} ·
								{token.lastUsedAt ? `used ${timeAgo(token.lastUsedAt)}` : 'never used'} ·
								{token.expiresAt ? `expires ${timeAgo(token.expiresAt)}` : 'never expires'}
							</div>
						</div>
						<Button variant="ghost" size="sm" onclick={() => revoke(token)}>Revoke</Button>
					</li>
				{/each}
			</ul>
		{/if}
	</Card.Content>
</Card.Root>
