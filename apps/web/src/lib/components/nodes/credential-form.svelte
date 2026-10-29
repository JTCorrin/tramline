<script lang="ts">
	import * as Field from '#lib/components/ui/field/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import type { CredentialField } from '@tramline/contracts';

	/**
	 * The "Connect account" form, generated from an adapter's credentials
	 * schema. Editing, secret fields start blank and keep their saved value
	 * unless something is typed.
	 */
	let {
		fields,
		values = $bindable(),
		editing = false
	}: {
		fields: CredentialField[];
		values: Record<string, string | number | boolean>;
		editing?: boolean;
	} = $props();
</script>

{#each fields as field (field.key)}
	{@const id = `credential-${field.key}`}
	<Field.Field>
		{#if field.type === 'boolean'}
			<label class="flex items-center gap-2 text-sm">
				<Switch
					checked={Boolean(values[field.key] ?? field.default)}
					onCheckedChange={(checked) => (values[field.key] = checked)}
					aria-label={field.label}
				/>
				{field.label}
			</label>
		{:else}
			<Field.Label for={id}>{field.label}</Field.Label>
			{#if field.type === 'enum'}
				<Select.Root
					type="single"
					value={String(values[field.key] ?? field.default ?? '')}
					onValueChange={(value) => (values[field.key] = value)}
				>
					<Select.Trigger {id} class="w-full"
						>{values[field.key] ?? field.default ?? 'Choose…'}</Select.Trigger
					>
					<Select.Content>
						{#each field.options ?? [] as option (option)}
							<Select.Item value={option}>{option}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			{:else if field.key === 'caCertificate'}
				<Textarea
					{id}
					value={String(values[field.key] ?? '')}
					oninput={(event) => (values[field.key] = event.currentTarget.value)}
					placeholder="-----BEGIN CERTIFICATE-----"
				/>
			{:else}
				<Input
					{id}
					type={field.secret ? 'password' : field.type === 'number' ? 'number' : 'text'}
					autocomplete="off"
					value={values[field.key] ?? ''}
					oninput={(event) => {
						const raw = event.currentTarget.value;
						values[field.key] = field.type === 'number' && raw !== '' ? Number(raw) : raw;
					}}
					placeholder={field.secret && editing
						? 'Saved; leave blank to keep it'
						: (field.placeholder ?? (field.default !== null ? String(field.default) : ''))}
					required={field.required && !(field.secret && editing)}
				/>
			{/if}
		{/if}
		{#if field.description}<Field.Description>{field.description}</Field.Description>{/if}
	</Field.Field>
{/each}
