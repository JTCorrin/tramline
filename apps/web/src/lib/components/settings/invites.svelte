<script lang="ts">
	import { api } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import { reportError } from '#lib/forms.js';
	import { timeAgo } from '#lib/format.js';
	import type { Invite } from '@tramline/client';
	import { toast } from 'svelte-sonner';

	let { invites: initial }: { invites: Invite[] } = $props();

	// svelte-ignore state_referenced_locally
	let invites = $state(initial);
	let role = $state<'member' | 'admin'>('member');
	let created = $state<string | null>(null);

	async function create() {
		try {
			const invite = await api().invites.create(role);
			created = invite.url;
			invites = [invite, ...invites];
		} catch (error) {
			reportError(error);
		}
	}

	async function revoke(invite: Invite) {
		try {
			await api().invites.revoke(invite.id);
			invites = invites.filter((i) => i.id !== invite.id);
		} catch (error) {
			reportError(error);
		}
	}
</script>

<Card.Root data-testid="invites">
	<Card.Header>
		<Card.Title>Invite people</Card.Title>
		<Card.Description>
			A link works once and expires after a week. Whoever opens it joins this organization, and can
			create an account even when sign-up on this install is by invitation only.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		{#if created}
			<div class="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
				<p class="font-medium">Send this link; it won't be shown again.</p>
				<div class="flex gap-2">
					<Input readonly value={created} class="font-mono text-xs" data-testid="invite-link" />
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
		<div class="flex gap-2">
			<Select.Root type="single" bind:value={role}>
				<Select.Trigger class="w-40" aria-label="Role"
					>{role === 'admin' ? 'Admin' : 'Member'}</Select.Trigger
				>
				<Select.Content>
					<Select.Item value="member">Member</Select.Item>
					<Select.Item value="admin">Admin</Select.Item>
				</Select.Content>
			</Select.Root>
			<Button onclick={create}>Create invite link</Button>
		</div>
		{#if invites.length}
			<ul class="divide-y rounded-lg border text-sm">
				{#each invites as invite (invite.id)}
					<li class="flex items-center gap-3 px-3 py-2">
						<span class="font-medium capitalize">{invite.role}</span>
						<span class="text-xs text-muted-foreground"
							>created {timeAgo(invite.createdAt)} · expires {timeAgo(invite.expiresAt)}</span
						>
						<Button class="ml-auto" size="sm" variant="ghost" onclick={() => revoke(invite)}
							>Revoke</Button
						>
					</li>
				{/each}
			</ul>
		{/if}
	</Card.Content>
</Card.Root>
