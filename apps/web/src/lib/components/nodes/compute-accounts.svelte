<script lang="ts">
	import { api } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import { reportError } from '#lib/forms.js';
	import type { AdapterAccount, AdapterInfo } from '@tramline/contracts';
	import { toast } from 'svelte-sonner';
	import CredentialForm from './credential-form.svelte';

	/** Connections to Proxmox or a cloud, which create machines that enroll as nodes. */
	let {
		adapters,
		accounts = $bindable()
	}: { adapters: AdapterInfo[]; accounts: AdapterAccount[] } = $props();

	const connectable = $derived(adapters.filter((a) => a.id !== 'manual'));
	const adapterName = (id: string) => adapters.find((a) => a.id === id)?.name ?? id;

	/** The account being edited, or 'new'; null when the form is closed. */
	let editing = $state<AdapterAccount | 'new' | null>(null);
	let adapterId = $state('');
	let name = $state('');
	let values = $state<Record<string, string | number | boolean>>({});
	const adapter = $derived(adapters.find((a) => a.id === adapterId));

	function open(account: AdapterAccount | 'new') {
		editing = account;
		if (account === 'new') {
			adapterId = connectable[0]?.id ?? '';
			name = '';
			values = {};
		} else {
			adapterId = account.adapter;
			name = account.name;
			values = { ...(account.credentials as Record<string, string | number | boolean>) };
		}
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		try {
			if (editing === 'new') {
				const created = await api().adapters.connect({
					adapter: adapterId,
					name: name.trim(),
					credentials: values
				});
				accounts = [...accounts, created];
				toast.success(`Connected ${created.name}. Test it to check the credentials.`);
			} else if (editing) {
				const updated = await api().adapters.updateAccount(editing.id, {
					name: name.trim(),
					credentials: values
				});
				accounts = accounts.map((a) => (a.id === updated.id ? updated : a));
				toast.success(`Saved ${updated.name}`);
			}
			editing = null;
		} catch (error) {
			reportError(error);
		}
	}

	async function test(account: AdapterAccount) {
		try {
			await api().adapters.test(account.id);
			toast.success(`${account.name}: connected`);
		} catch (error) {
			reportError(error);
		}
	}

	async function remove(account: AdapterAccount) {
		if (!confirm(`Remove ${account.name}? Its credentials are deleted.`)) return;
		try {
			await api().adapters.removeAccount(account.id);
			accounts = accounts.filter((a) => a.id !== account.id);
		} catch (error) {
			reportError(error);
		}
	}
</script>

{#if connectable.length}
	<Card.Root data-testid="compute-accounts">
		<Card.Header>
			<Card.Title>Compute accounts</Card.Title>
			<Card.Description>
				Connect Proxmox or a cloud, and Tramline creates machines there that enroll themselves as
				nodes. Credentials are stored encrypted, and secrets are never shown again.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#if accounts.length}
				<ul class="divide-y rounded-lg border text-sm">
					{#each accounts as account (account.id)}
						<li class="flex flex-wrap items-center gap-3 px-3 py-2" data-testid="compute-account">
							<span class="font-medium">{account.name}</span>
							<span class="text-xs text-muted-foreground">
								{adapterName(account.adapter)} · {account.nodes} node{account.nodes === 1
									? ''
									: 's'}
							</span>
							<span class="ml-auto flex gap-1">
								<Button size="sm" variant="outline" onclick={() => test(account)}
									>Test connection</Button
								>
								<Button size="sm" variant="ghost" onclick={() => open(account)}>Edit</Button>
								<Button size="sm" variant="ghost" onclick={() => remove(account)}>Remove</Button>
							</span>
						</li>
					{/each}
				</ul>
			{/if}

			{#if editing}
				<form class="space-y-4 rounded-lg border p-3" onsubmit={save}>
					{#if editing === 'new'}
						<Field.Field>
							<Field.Label for="account-adapter">Provider</Field.Label>
							<Select.Root
								type="single"
								value={adapterId}
								onValueChange={(value) => {
									adapterId = value;
									values = {};
								}}
							>
								<Select.Trigger id="account-adapter" class="w-full" aria-label="Provider"
									>{adapter?.name ?? 'Choose…'}</Select.Trigger
								>
								<Select.Content>
									{#each connectable as option (option.id)}
										<Select.Item value={option.id}>{option.name}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
							{#if adapter}<Field.Description>{adapter.description}</Field.Description>{/if}
						</Field.Field>
					{/if}
					<Field.Field>
						<Field.Label for="account-name">Account name</Field.Label>
						<Input id="account-name" bind:value={name} placeholder="Home lab" required />
					</Field.Field>
					{#if adapter}
						<CredentialForm fields={adapter.fields} bind:values editing={editing !== 'new'} />
					{/if}
					<div class="flex gap-2">
						<Button type="submit">{editing === 'new' ? 'Connect' : 'Save'}</Button>
						<Button variant="ghost" onclick={() => (editing = null)}>Cancel</Button>
					</div>
				</form>
			{:else}
				<Button variant="outline" onclick={() => open('new')}>Connect an account</Button>
			{/if}
		</Card.Content>
	</Card.Root>
{/if}
