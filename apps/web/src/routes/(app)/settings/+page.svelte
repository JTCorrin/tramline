<script lang="ts">
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import { api } from '#lib/api.js';
	import AccountSecurity from '#lib/components/settings/account-security.svelte';
	import ApiTokens from '#lib/components/settings/api-tokens.svelte';
	import AuditLog from '#lib/components/settings/audit-log.svelte';
	import BackupStorage from '#lib/components/settings/backup-storage.svelte';
	import GithubActions from '#lib/components/settings/github-actions.svelte';
	import { Button, buttonVariants } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { reportError } from '#lib/forms.js';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import type { GitHubManifestForm } from '@tramline/contracts';
	import { tick } from 'svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const github = $derived(data.github);

	let owner = $state('');
	let pending = $state(false);
	let form = $state<HTMLFormElement>();
	let manifest = $state<GitHubManifestForm>();

	async function createApp() {
		pending = true;
		try {
			manifest = await api().github.manifest(owner.trim() || null);
			await tick();
			// GitHub's manifest flow needs a real form post from the browser
			form?.submit();
		} catch (error) {
			reportError(error);
			pending = false;
		}
	}

	async function disconnect(id: string) {
		try {
			await api().github.disconnect(id);
			await invalidateAll();
		} catch (error) {
			reportError(error);
		}
	}
</script>

<svelte:head><title>Settings · Tramline</title></svelte:head>

<main class="mx-auto w-full max-w-3xl space-y-6 p-6">
	<h1 class="text-xl font-semibold tracking-tight">Settings</h1>

	<Card.Root data-testid="github-settings">
		<Card.Header>
			<Card.Title>GitHub</Card.Title>
			<Card.Description>
				Deploy private repositories and redeploy on every push. Tramline uses its own GitHub App
				with read-only access to the repositories you choose, and short-lived tokens instead of
				stored keys.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#if page.url.searchParams.has('github')}
				<p class="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
					GitHub is connected.
				</p>
			{/if}

			{#if !github.app}
				{#if github.canManage}
					<Field.Field>
						<Field.Label for="github-owner">GitHub organization (optional)</Field.Label>
						<Input
							id="github-owner"
							placeholder="Leave empty to create it on your account"
							bind:value={owner}
						/>
						<Field.Description>
							GitHub will ask you to confirm, then you choose which repositories it can read.
						</Field.Description>
					</Field.Field>
					<Button onclick={createApp} disabled={pending}>Create GitHub App</Button>
				{:else}
					<p class="text-sm text-muted-foreground">
						Ask an owner or admin of this organization to connect GitHub.
					</p>
				{/if}
			{:else}
				<div class="flex items-center justify-between gap-4 rounded-lg border p-3">
					<div>
						<div class="text-sm font-medium">{github.app.name}</div>
						<div class="text-xs text-muted-foreground">
							{github.webhooks
								? 'Pushes arrive by webhook.'
								: 'GitHub can’t reach this install, so Tramline checks for new commits every minute.'}
						</div>
					</div>
					<a
						href={github.app.htmlUrl}
						target="_blank"
						rel="external noreferrer"
						class={buttonVariants({ variant: 'ghost', size: 'sm' })}
					>
						App on GitHub <ExternalLinkIcon />
					</a>
				</div>

				<div class="space-y-2">
					<h3 class="text-sm font-medium">Installations</h3>
					{#each github.installations as installation (installation.id)}
						<div class="flex items-center justify-between rounded-lg border p-3 text-sm">
							<span
								>{installation.account}
								<span class="text-muted-foreground">· {installation.accountType}</span></span
							>
							<div class="flex gap-1">
								<a
									href={installation.htmlUrl}
									target="_blank"
									rel="external noreferrer"
									class={buttonVariants({ variant: 'ghost', size: 'sm' })}
								>
									Repositories <ExternalLinkIcon />
								</a>
								{#if github.canManage}
									<Button variant="ghost" size="sm" onclick={() => disconnect(installation.id)}
										>Disconnect</Button
									>
								{/if}
							</div>
						</div>
					{:else}
						<p class="text-sm text-muted-foreground">Not installed on any GitHub account yet.</p>
					{/each}
					{#if github.canManage}
						<a
							href="/api/github/install"
							rel="external"
							class={buttonVariants({ variant: 'outline', size: 'sm' })}
						>
							Install on GitHub
						</a>
					{/if}
				</div>
			{/if}
		</Card.Content>
	</Card.Root>

	<AccountSecurity twoFactorEnabled={data.user.twoFactorEnabled} />

	<ApiTokens tokens={data.tokens} />

	{#if data.trust}
		<GithubActions rules={data.trust} audience={data.oidcAudience} />
	{/if}

	<BackupStorage
		storage={data.backups.storage}
		canManage={data.backups.canManage}
		controlPlane={data.backups.controlPlane}
	/>

	{#if data.audit}
		<AuditLog events={data.audit} />
	{/if}
</main>

{#if manifest}
	<form bind:this={form} method="post" action={manifest.action} class="hidden">
		<input type="hidden" name="manifest" value={manifest.manifest} />
	</form>
{/if}
