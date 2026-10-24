<script lang="ts">
	import { api } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { reportError } from '#lib/forms.js';
	import type { BackupStorage, ControlPlaneBackupStatus } from '@tramline/contracts';
	import { formatBytes, timeAgo } from '#lib/format.js';
	import { toast } from 'svelte-sonner';

	let {
		storage,
		canManage,
		controlPlane
	}: {
		storage: BackupStorage | null;
		canManage: boolean;
		controlPlane: ControlPlaneBackupStatus | null;
	} = $props();

	let saved = $state<BackupStorage | null>(null);
	const current = $derived(saved ?? storage);
	// svelte-ignore state_referenced_locally
	let values = $state({
		endpoint: storage?.endpoint ?? '',
		region: storage?.region ?? 'us-east-1',
		bucket: storage?.bucket ?? '',
		prefix: storage?.prefix ?? '',
		accessKeyId: storage?.accessKeyId ?? '',
		secretAccessKey: '',
		pathStyle: storage?.pathStyle ?? true
	});
	let busy = $state(false);

	async function save(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		try {
			saved = await api().backups.saveStorage({
				...values,
				secretAccessKey: values.secretAccessKey || undefined
			});
			values.secretAccessKey = '';
			toast.success('Backup storage saved');
		} catch (error) {
			reportError(error);
		} finally {
			busy = false;
		}
	}

	async function test() {
		busy = true;
		try {
			await api().backups.testStorage();
			toast.success('Connected: Tramline can write to the bucket');
		} catch (error) {
			reportError(error);
		} finally {
			busy = false;
		}
	}
</script>

<Card.Root data-testid="backup-storage">
	<Card.Header>
		<Card.Title>Backups</Card.Title>
		<Card.Description>
			An S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO…) for this organization's
			backups. Backups are encrypted on the node before they are uploaded, and nodes only ever get
			short-lived links to single files, never these credentials.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if canManage}
			<form class="space-y-4" onsubmit={save}>
				<div class="grid gap-4 sm:grid-cols-2">
					<Field.Field class="sm:col-span-2">
						<Field.Label for="bk-endpoint">Endpoint</Field.Label>
						<Input
							id="bk-endpoint"
							placeholder="https://s3.eu-west-1.amazonaws.com"
							bind:value={values.endpoint}
							required
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="bk-bucket">Bucket</Field.Label>
						<Input id="bk-bucket" bind:value={values.bucket} required />
					</Field.Field>
					<Field.Field>
						<Field.Label for="bk-region">Region</Field.Label>
						<Input id="bk-region" bind:value={values.region} />
					</Field.Field>
					<Field.Field>
						<Field.Label for="bk-key">Access key ID</Field.Label>
						<Input id="bk-key" bind:value={values.accessKeyId} autocomplete="off" required />
					</Field.Field>
					<Field.Field>
						<Field.Label for="bk-secret">Secret access key</Field.Label>
						<Input
							id="bk-secret"
							type="password"
							autocomplete="new-password"
							placeholder={current ? 'Saved; leave empty to keep' : ''}
							bind:value={values.secretAccessKey}
							required={!current}
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="bk-prefix">Folder (optional)</Field.Label>
						<Input id="bk-prefix" placeholder="tramline" bind:value={values.prefix} />
					</Field.Field>
					<div class="flex items-center gap-3 self-end pb-2">
						<Switch
							id="bk-path-style"
							bind:checked={values.pathStyle}
							aria-label="Path-style addressing"
						/>
						<label for="bk-path-style" class="text-sm"
							>Path-style URLs (MinIO, most self-hosted)</label
						>
					</div>
				</div>
				<div class="flex gap-2">
					<Button type="submit" disabled={busy}>Save</Button>
					{#if current}
						<Button type="button" variant="outline" disabled={busy} onclick={test}>
							Test connection
						</Button>
					{/if}
				</div>
			</form>
		{:else if current}
			<p class="text-sm text-muted-foreground">
				Backups go to <code class="font-mono">{current.bucket}</code> at
				<code class="font-mono">{current.endpoint}</code>.
			</p>
		{:else}
			<p class="text-sm text-muted-foreground">
				An organization owner or admin can set up backup storage.
			</p>
		{/if}
		{#if controlPlane}
			<div class="mt-6 space-y-1 border-t pt-4 text-sm" data-testid="control-plane-backups">
				<div class="font-medium">This install's database</div>
				{#if !controlPlane.configured}
					<p class="text-muted-foreground">
						Not backed up. Set <code class="font-mono">TRAMLINE_BACKUP_S3_*</code> to snapshot it, encrypted,
						every hour.
					</p>
				{:else}
					{#if controlPlane.snapshot}
						<p class={controlPlane.snapshot.status === 'failed' ? 'text-destructive' : ''}>
							{controlPlane.snapshot.status === 'succeeded'
								? `Last snapshot ${timeAgo(controlPlane.snapshot.createdAt)} (${formatBytes(controlPlane.snapshot.size ?? 0)})`
								: `Snapshot failed ${timeAgo(controlPlane.snapshot.createdAt)}: ${controlPlane.snapshot.error}`}
						</p>
					{:else}
						<p class="text-muted-foreground">The first snapshot runs within a minute.</p>
					{/if}
					{#if controlPlane.drill}
						<p
							class={controlPlane.drill.status === 'failed'
								? 'text-destructive'
								: 'text-muted-foreground'}
						>
							{controlPlane.drill.status === 'succeeded'
								? `Restore drill passed ${timeAgo(controlPlane.drill.createdAt)}: the newest snapshot decrypts and passes SQLite's integrity check`
								: `Restore drill failed ${timeAgo(controlPlane.drill.createdAt)}: ${controlPlane.drill.error}`}
						</p>
					{/if}
				{/if}
			</div>
		{/if}
	</Card.Content>
</Card.Root>
