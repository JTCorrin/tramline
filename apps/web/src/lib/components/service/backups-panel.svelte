<script lang="ts">
	import { resolve } from '$app/paths';
	import { api } from '#lib/api.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import { reportError } from '#lib/forms.js';
	import { formatBytes, timeAgo } from '#lib/format.js';
	import { cn } from '#lib/utils.js';
	import { BACKUP_SCHEDULES, type Backup, type Volume } from '@tramline/contracts';
	import { toast } from 'svelte-sonner';
	import CommitInput from './commit-input.svelte';
	import Setting from './setting.svelte';

	let {
		serviceId,
		environmentId,
		version
	}: { serviceId: string; environmentId: string; version: number } = $props();

	const client = api();
	let volume = $state<Volume | null>();
	let backups = $state<Backup[]>([]);
	let storageReady = $state(true);
	let confirm = $state<Backup | null>(null);

	const SCHEDULE_LABELS: Record<(typeof BACKUP_SCHEDULES)[number], string> = {
		off: 'Off',
		daily: 'Daily',
		weekly: 'Weekly'
	};
	const KIND_LABELS: Record<Volume['backupKind'], string> = {
		postgres: 'a pg_dumpall of every database',
		mysql: 'a mysqldump of every database',
		mongo: 'a mongodump archive',
		volume: 'an archive of the volume'
	};
	const STATUS_STYLES: Record<Backup['status'], string> = {
		pending: 'text-muted-foreground',
		running: 'text-sky-600 dark:text-sky-400',
		succeeded: 'text-emerald-600 dark:text-emerald-400',
		failed: 'text-destructive'
	};

	async function load() {
		const [found] = await client.backups.volumes({ serviceId, environmentId });
		volume = found ?? null;
		backups = found ? await client.backups.getAll({ volumeId: found.id }) : [];
		storageReady = (await client.backups.storage()).storage !== null;
	}

	$effect(() => {
		void version;
		load().catch(reportError);
	});

	// jobs report through the agent; check back while one is in flight
	$effect(() => {
		const busy = backups.some(
			(b) => ['pending', 'running'].includes(b.status) || b.restore?.status === 'running'
		);
		if (!busy) return;
		const timer = setInterval(() => load().catch(reportError), 3000);
		return () => clearInterval(timer);
	});

	async function update(patch: Parameters<typeof client.backups.updateVolume>[1]) {
		try {
			volume = await client.backups.updateVolume(volume!.id, patch);
			toast.success('Backup schedule saved');
		} catch (error) {
			reportError(error);
		}
	}

	async function backUp() {
		try {
			await client.backups.create(volume!.id);
			toast.success('Backup started');
			await load();
		} catch (error) {
			reportError(error);
		}
	}

	async function restore(backup: Backup) {
		try {
			await client.backups.restore(backup.id);
			toast.success('Restore started');
			await load();
		} catch (error) {
			reportError(error);
		}
	}

	async function remove(backup: Backup) {
		try {
			await client.backups.remove(backup.id);
			toast.success('Backup deleted');
			await load();
		} catch (error) {
			reportError(error);
		}
	}
</script>

{#if volume === null}
	<div class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
		<p class="font-medium text-foreground">No volume yet</p>
		<p class="mt-1">Deploy the service with a volume to back it up.</p>
	</div>
{:else if volume}
	<div class="space-y-6" data-testid="backups">
		{#if !storageReady}
			<div class="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
				Backups need a bucket.
				<a href={resolve('/(app)/settings')} class="font-medium underline">Set up backup storage</a>
				in Settings.
			</div>
		{/if}

		<section class="space-y-4">
			<p class="text-xs text-muted-foreground">
				Each backup is {KIND_LABELS[volume.backupKind]}, compressed and encrypted on the node before
				it is uploaded.
			</p>
			<div class="grid grid-cols-2 gap-4">
				<Setting label="Schedule">
					<Select.Root
						type="single"
						value={volume.backupSchedule}
						onValueChange={(v) =>
							update({ backupSchedule: v as (typeof BACKUP_SCHEDULES)[number] })}
					>
						<Select.Trigger class="w-full" aria-label="Backup schedule">
							{SCHEDULE_LABELS[volume.backupSchedule]}
						</Select.Trigger>
						<Select.Content>
							{#each BACKUP_SCHEDULES as schedule (schedule)}
								<Select.Item value={schedule}>{SCHEDULE_LABELS[schedule]}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</Setting>
				<Setting label="Keep" for="backup-retention" description="Scheduled backups kept">
					<CommitInput
						id="backup-retention"
						type="number"
						value={volume.backupRetention}
						onsave={(v) => update({ backupRetention: Number(v) })}
					/>
				</Setting>
			</div>
			<Button size="sm" onclick={backUp} disabled={!storageReady}>Back up now</Button>
		</section>

		{#if backups.length}
			<ul class="divide-y rounded-lg border" data-testid="backup-list">
				{#each backups as backup (backup.id)}
					<li class="flex items-center gap-3 px-3 py-3 text-sm">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class={cn('font-medium capitalize', STATUS_STYLES[backup.status])}>
									{backup.status}
								</span>
								<span class="text-xs text-muted-foreground">
									{backup.trigger} · {timeAgo(backup.createdAt)}
									{#if backup.size !== null}· {formatBytes(backup.size)}{/if}
								</span>
							</div>
							{#if backup.error}
								<p class="mt-0.5 text-xs text-destructive">{backup.error}</p>
							{/if}
							{#if backup.restore}
								<p
									class={cn('mt-0.5 text-xs', STATUS_STYLES[backup.restore.status])}
									data-testid="restore-status"
								>
									Restore {backup.restore.status}
									{timeAgo(backup.restore.createdAt)}{backup.restore.error
										? `: ${backup.restore.error}`
										: ''}
								</p>
							{/if}
						</div>
						{#if backup.status === 'succeeded'}
							<Button variant="outline" size="sm" onclick={() => (confirm = backup)}>Restore</Button
							>
						{/if}
						{#if backup.status === 'succeeded' || backup.status === 'failed'}
							<Button variant="ghost" size="sm" onclick={() => remove(backup)}>Delete</Button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}

<AlertDialog.Root open={confirm !== null} onOpenChange={(open) => !open && (confirm = null)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Restore this backup?</AlertDialog.Title>
			<AlertDialog.Description>
				{#if volume?.backupKind === 'volume'}
					The service stops while its volume is replaced with the backup from
					{confirm ? timeAgo(confirm.createdAt) : ''}, then starts again. Anything written since is
					lost.
				{:else}
					The databases are replaced with the backup from {confirm
						? timeAgo(confirm.createdAt)
						: ''}. Connected apps are disconnected, and anything written since is lost.
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={() => {
					const backup = confirm!;
					confirm = null;
					void restore(backup);
				}}
			>
				Restore
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
