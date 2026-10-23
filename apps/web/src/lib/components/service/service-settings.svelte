<script lang="ts">
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import {
		RESTART_POLICIES,
		type CanvasService,
		type ServiceConfig,
		type ServiceConfigPatch,
		type ServiceConfigView
	} from '@tramline/contracts';
	import CommitInput from './commit-input.svelte';
	import Setting from './setting.svelte';

	let {
		service,
		environmentName,
		view,
		onstage,
		onrename,
		ondelete
	}: {
		service: CanvasService;
		environmentName: string;
		view: ServiceConfigView;
		onstage: (patch: ServiceConfigPatch) => void;
		onrename: (name: string) => void;
		ondelete: () => void;
	} = $props();

	const config = $derived(view.effective);
	let confirmDelete = $state(false);

	type Section = 'build' | 'deploy' | 'networking';

	/** Whether a field differs from the last deploy. */
	function staged<S extends Section>(section: S, key: keyof ServiceConfig[S]) {
		return view.applied !== null && view.applied[section][key] !== config[section][key];
	}
	const sourceStaged = $derived(
		view.applied !== null && JSON.stringify(view.applied.source) !== JSON.stringify(config.source)
	);

	const stage = <S extends Section>(section: S, values: Partial<ServiceConfig[S]>) =>
		onstage({ [section]: values });

	const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
	const toNumber = (value: string | null) => (value === null ? null : Number(value));

	const POLICY_LABELS: Record<(typeof RESTART_POLICIES)[number], string> = {
		on_failure: 'On failure',
		always: 'Always',
		never: 'Never'
	};
</script>

<div class="space-y-8 p-4">
	<section class="space-y-4">
		<h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Service</h3>
		<Setting
			label="Name"
			for="service-name"
			description="Also used in references, e.g. &#36;&#123;&#123;{service.name}.KEY&#125;&#125;"
		>
			<CommitInput id="service-name" value={service.name} onsave={(v) => v && onrename(v)} />
		</Setting>
	</section>

	<section class="space-y-4">
		<h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Source</h3>
		{#if config.source?.type === 'repo'}
			{@const source = config.source}
			<Setting label="Repository" for="source-repo" staged={sourceStaged}>
				<CommitInput
					id="source-repo"
					mono
					value={source.repo}
					onsave={(v) => v && onstage({ source: { ...source, repo: v } })}
				/>
			</Setting>
			<div class="grid grid-cols-2 gap-3">
				<Setting label="Branch" for="source-branch">
					<CommitInput
						id="source-branch"
						mono
						value={source.branch}
						onsave={(v) => v && onstage({ source: { ...source, branch: v } })}
					/>
				</Setting>
				<Setting label="Root directory" for="source-root">
					<CommitInput
						id="source-root"
						mono
						value={source.rootDirectory}
						onsave={(v) => onstage({ source: { ...source, rootDirectory: v ?? '/' } })}
					/>
				</Setting>
			</div>
		{:else}
			<Setting
				label="Image"
				for="source-image"
				staged={sourceStaged}
				description={config.source ? undefined : 'Set an image to make this service deployable.'}
			>
				<CommitInput
					id="source-image"
					mono
					placeholder="nginx:latest"
					value={config.source?.type === 'image' ? config.source.image : null}
					onsave={(v) => onstage({ source: v ? { type: 'image', image: v } : null })}
				/>
			</Setting>
		{/if}
	</section>

	{#if config.source?.type === 'repo'}
		<section class="space-y-4">
			<h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Build</h3>
			<Setting label="Builder" staged={staged('build', 'builder')}>
				<Select.Root
					type="single"
					value={config.build.builder}
					onValueChange={(v) => stage('build', { builder: v as 'railpack' | 'dockerfile' })}
				>
					<Select.Trigger class="w-full">
						{config.build.builder === 'railpack' ? 'Railpack (zero config)' : 'Dockerfile'}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="railpack">Railpack (zero config)</Select.Item>
						<Select.Item value="dockerfile">Dockerfile</Select.Item>
					</Select.Content>
				</Select.Root>
			</Setting>
			{#if config.build.builder === 'dockerfile'}
				<Setting
					label="Dockerfile path"
					for="build-dockerfile"
					staged={staged('build', 'dockerfilePath')}
				>
					<CommitInput
						id="build-dockerfile"
						mono
						placeholder="Dockerfile"
						value={config.build.dockerfilePath}
						onsave={(v) => stage('build', { dockerfilePath: v })}
					/>
				</Setting>
			{:else}
				<Setting label="Build command" for="build-command" staged={staged('build', 'buildCommand')}>
					<CommitInput
						id="build-command"
						mono
						placeholder="Detected automatically"
						value={config.build.buildCommand}
						onsave={(v) => stage('build', { buildCommand: v })}
					/>
				</Setting>
			{/if}
		</section>
	{/if}

	<section class="space-y-4">
		<h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Deploy</h3>
		<Setting label="Start command" for="deploy-start" staged={staged('deploy', 'startCommand')}>
			<CommitInput
				id="deploy-start"
				mono
				placeholder="Image or build default"
				value={config.deploy.startCommand}
				onsave={(v) => stage('deploy', { startCommand: v })}
			/>
		</Setting>
		<div class="grid grid-cols-2 gap-3">
			<Setting label="Replicas" for="deploy-replicas" staged={staged('deploy', 'replicas')}>
				<CommitInput
					id="deploy-replicas"
					type="number"
					value={config.deploy.replicas}
					onsave={(v) => stage('deploy', { replicas: toNumber(v) ?? 1 })}
				/>
			</Setting>
			<Setting label="Restart policy" staged={staged('deploy', 'restartPolicy')}>
				<Select.Root
					type="single"
					value={config.deploy.restartPolicy}
					onValueChange={(v) =>
						stage('deploy', { restartPolicy: v as (typeof RESTART_POLICIES)[number] })}
				>
					<Select.Trigger class="w-full"
						>{POLICY_LABELS[config.deploy.restartPolicy]}</Select.Trigger
					>
					<Select.Content>
						{#each RESTART_POLICIES as policy (policy)}
							<Select.Item value={policy}>{POLICY_LABELS[policy]}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</Setting>
		</div>
		<Setting
			label="Healthcheck path"
			for="deploy-healthcheck"
			staged={staged('deploy', 'healthcheckPath')}
			description="New deployments only receive traffic once this returns 200."
		>
			<CommitInput
				id="deploy-healthcheck"
				mono
				placeholder="/health"
				value={config.deploy.healthcheckPath}
				onsave={(v) => stage('deploy', { healthcheckPath: v })}
			/>
		</Setting>
		<Setting
			label="Cron schedule"
			for="deploy-cron"
			staged={staged('deploy', 'cronSchedule')}
			description="Run on a schedule instead of continuously, e.g. 0 * * * *"
		>
			<CommitInput
				id="deploy-cron"
				mono
				value={config.deploy.cronSchedule}
				onsave={(v) => stage('deploy', { cronSchedule: v })}
			/>
		</Setting>
	</section>

	<section class="space-y-4">
		<h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Networking</h3>
		<Setting
			label="Port"
			for="net-port"
			staged={staged('networking', 'port')}
			description="The port your service listens on. Exposed to it as $PORT."
		>
			<CommitInput
				id="net-port"
				type="number"
				placeholder="8080"
				value={config.networking.port}
				onsave={(v) => stage('networking', { port: toNumber(v) })}
			/>
		</Setting>
		<div class="flex items-center justify-between gap-4 rounded-lg border p-3">
			<div>
				<div class="flex items-center gap-2 text-sm font-medium">
					Public domain
					{#if staged('networking', 'publicDomain')}
						<span class="size-1.5 rounded-full bg-amber-400"></span>
					{/if}
				</div>
				<p class="text-xs text-muted-foreground">Generate a public HTTPS URL on deploy.</p>
			</div>
			<Switch
				checked={config.networking.publicDomain}
				onCheckedChange={(checked) => stage('networking', { publicDomain: checked })}
				aria-label="Public domain"
			/>
		</div>
		<p class="text-xs text-muted-foreground">
			Private address: <code class="font-mono"
				>{slug(service.name)}.{slug(environmentName)}.tramline.internal</code
			>
		</p>
	</section>

	<section class="space-y-3 rounded-lg border border-destructive/40 p-4">
		<h3 class="text-sm font-medium">Delete service</h3>
		<p class="text-xs text-muted-foreground">
			Removes the service from every environment, along with its variables and deployments.
		</p>
		<Button variant="destructive" size="sm" onclick={() => (confirmDelete = true)}>
			Delete {service.name}
		</Button>
	</section>
</div>

<AlertDialog.Root bind:open={confirmDelete}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete {service.name}?</AlertDialog.Title>
			<AlertDialog.Description>
				This removes it from every environment immediately. It cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action variant="destructive" onclick={ondelete}
				>Delete service</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
