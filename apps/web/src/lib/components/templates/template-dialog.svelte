<script lang="ts">
	import { api } from '#lib/api.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { reportError } from '#lib/forms.js';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import * as Select from '#lib/components/ui/select/index.js';
	import type {
		InstalledTemplate,
		NodeSummary,
		Position,
		TemplateSummary
	} from '@tramline/contracts';
	import TemplateIcon from './template-icon.svelte';

	/**
	 * The template gallery: pick a stack, answer its questions, and add it to
	 * the canvas (staged, to review) or deploy it straight away. Without a
	 * project, it makes one for the template first.
	 */
	let {
		open = $bindable(false),
		chosen = $bindable<string | null>(null),
		project = null,
		position,
		oninstalled,
		ondone
	}: {
		open?: boolean;
		/** The template shown; null shows the gallery. */
		chosen?: string | null;
		/** Where it goes: the project, the environment to deploy to, and its other staged changes. */
		project?: { id: string; environmentId: string; environmentName: string; staged: number } | null;
		/** Where its first service lands on the canvas. */
		position?: Position;
		oninstalled: (result: InstalledTemplate, projectId: string) => void | Promise<void>;
		/** After its notes are read: a new project is opened. */
		ondone?: (result: InstalledTemplate, projectId: string) => void | Promise<void>;
	} = $props();

	const client = api();
	let templates = $state<TemplateSummary[] | null>(null);
	let nodes = $state<NodeSummary[]>([]);
	const ANY = 'any';
	let runOn = $state(ANY);
	let answers = $state<Record<string, string>>({});
	let projectName = $state('');
	let pending = $state<'add' | 'deploy' | null>(null);
	let done = $state<InstalledTemplate | null>(null);
	let doneIn = $state('');

	const template = $derived(templates?.find((t) => t.id === chosen) ?? null);

	$effect(() => {
		if (!open || templates) return;
		client.templates.list().then((list) => (templates = list), reportError);
	});

	$effect(() => {
		if (!open) return;
		// what's online now, to say where it can run
		client.nodes.getAll().then(
			(list) => (nodes = list.filter((n) => n.status === 'online' && !n.cordoned)),
			() => (nodes = [])
		);
	});

	const free = (n: NodeSummary) => (n.memoryMb ?? 0) - n.allocatedMemoryMb;
	/** Nodes with room for the whole template at once. */
	const roomy = $derived(
		template ? nodes.filter((n) => free(n) >= template.requests.memoryMb) : []
	);
	const chosenNode = $derived(nodes.find((n) => n.id === runOn));

	// a fresh form for each template
	$effect(() => {
		if (!template) return;
		answers = Object.fromEntries(template.questions.map((q) => [q.key, q.default ?? '']));
		projectName = template.name;
		done = null;
	});

	$effect(() => {
		if (!open) done = null;
	});

	const memory = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
	const shortImage = (image: string) => image.split('@')[0]!;
	const missing = $derived(
		template?.questions.filter((q) => q.required && !answers[q.key]?.trim()) ?? []
	);

	async function install(deploy: boolean) {
		if (!template) return;
		pending = deploy ? 'deploy' : 'add';
		try {
			let target = project;
			if (!target) {
				const created = await client.projects.create({ name: projectName.trim() });
				const [env] = await client.environments.getAll({ projectId: created.id });
				target = {
					id: created.id,
					environmentId: env!.id,
					environmentName: env!.name,
					staged: 0
				};
			}
			const result = await client.templates.install(target.id, {
				template: template.id,
				answers,
				position,
				node: runOn === ANY ? null : runOn,
				deploy: deploy ? target.environmentId : null
			});
			done = result;
			doneIn = target.id;
			await oninstalled(result, target.id);
		} catch (error) {
			reportError(error);
		} finally {
			pending = null;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-3xl" data-testid="template-dialog">
		{#if done && template}
			<Dialog.Header>
				<Dialog.Title>{template.name} is on the canvas</Dialog.Title>
				<Dialog.Description>
					{done.deployments.length
						? `Deploying ${done.services.length} services. They show on the canvas as they come up.`
						: `${done.services.length} services are staged. Review them, then deploy from the bar at the bottom.`}
				</Dialog.Description>
			</Dialog.Header>
			{#if done.notes.length}
				<ul class="space-y-2 py-2 text-sm" data-testid="template-notes">
					{#each done.notes as note (note)}
						<li class="rounded-md border bg-muted/40 p-3">{note}</li>
					{/each}
				</ul>
			{/if}
			<Dialog.Footer>
				<Button
					onclick={async () => {
						const result = done!;
						open = false;
						await ondone?.(result, doneIn);
					}}>{project ? 'Done' : 'Open project'}</Button
				>
			</Dialog.Footer>
		{:else if template}
			<Dialog.Header>
				<div class="flex items-center gap-3">
					<Button
						variant="ghost"
						size="icon"
						aria-label="All templates"
						onclick={() => (chosen = null)}
					>
						<ArrowLeftIcon />
					</Button>
					<TemplateIcon icon={template.icon} />
					<div class="min-w-0">
						<Dialog.Title>{template.name}</Dialog.Title>
						<Dialog.Description>{template.tagline}</Dialog.Description>
					</div>
				</div>
			</Dialog.Header>
			<form
				class="grid gap-5 py-2 md:grid-cols-[1fr_16rem]"
				onsubmit={(event) => {
					event.preventDefault();
					void install(false);
				}}
			>
				<div class="space-y-4">
					<p class="text-sm text-muted-foreground">{template.description}</p>
					{#if !project}
						<Field.Field>
							<Field.Label for="template-project">Project name</Field.Label>
							<Input id="template-project" required maxlength={64} bind:value={projectName} />
						</Field.Field>
					{/if}
					<Field.Field>
						<Field.Label for="template-node">Run on</Field.Label>
						<Select.Root type="single" value={runOn} onValueChange={(v) => (runOn = v)}>
							<Select.Trigger id="template-node" class="w-full" aria-label="Run on"
								>{chosenNode
									? `${chosenNode.name} · ${memory(free(chosenNode))} free`
									: 'Any node with room'}</Select.Trigger
							>
							<Select.Content>
								<Select.Item value={ANY}>Any node with room</Select.Item>
								{#each nodes as n (n.id)}
									<Select.Item value={n.id}>{n.name} · {memory(free(n))} free</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
						<Field.Description data-testid="template-placement">
							{#if chosenNode}
								Every service runs on {chosenNode.name}{free(chosenNode) <
								template.requests.memoryMb
									? `, which has ${memory(free(chosenNode))} free of the ${memory(template.requests.memoryMb)} they reserve: some will wait for room`
									: ''}.
							{:else if !nodes.length}
								No node is online, so its services will wait for one.
							{:else if roomy.length}
								Tramline puts each service on a node with room. {roomy
									.map((n) => n.name)
									.join(', ')}
								{roomy.length === 1 ? 'has' : 'have'} room for all of them.
							{:else}
								No single node has {memory(template.requests.memoryMb)} free, so its services will be
								spread out, and some may wait for room.
							{/if}
							The canvas shows where each one lands.
						</Field.Description>
					</Field.Field>
					{#each template.questions as q (q.key)}
						<Field.Field>
							<Field.Label for="template-{q.key}">
								{q.label}{#if !q.required}<span class="text-muted-foreground">
										(optional)</span
									>{/if}
							</Field.Label>
							<Input
								id="template-{q.key}"
								type={q.secret ? 'password' : 'text'}
								placeholder={q.placeholder}
								required={q.required}
								autocomplete="off"
								bind:value={answers[q.key]}
							/>
							{#if q.description}<Field.Description>{q.description}</Field.Description>{/if}
						</Field.Field>
					{/each}
				</div>
				<aside class="space-y-3 text-sm">
					<div class="font-medium">
						{template.services.length} service{template.services.length === 1 ? '' : 's'}
					</div>
					<ul class="space-y-1.5" data-testid="template-services">
						{#each template.services as s (s.key)}
							<li class="rounded-md border px-2.5 py-1.5">
								<div class="flex items-center gap-1.5">
									<span class="font-medium">{s.name}</span>
									{#if s.publicDomain}<GlobeIcon
											class="size-3.5 text-muted-foreground"
											aria-label="Public domain"
										/>{/if}
									{#if s.volume}<HardDriveIcon
											class="size-3.5 text-muted-foreground"
											aria-label="Volume"
										/>{/if}
								</div>
								<div class="truncate font-mono text-xs text-muted-foreground" title={s.image}>
									{shortImage(s.image)}
								</div>
							</li>
						{/each}
					</ul>
					<p class="text-xs text-muted-foreground">
						Reserves about {memory(template.requests.memoryMb)} of memory and {template.requests
							.cpus}
						CPU. Images are pinned by digest, and generated secrets are sealed, with new ones in each
						environment.
					</p>
					{#if template.docsUrl}
						<!-- eslint-disable svelte/no-navigation-without-resolve -- the template's docs, on another site -->
						<a
							class="inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
							href={template.docsUrl}
							target="_blank"
							rel="noreferrer"
						>
							{template.name} docs <ExternalLinkIcon class="size-3" />
						</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					{/if}
				</aside>
				<div class="flex flex-wrap items-center justify-end gap-2 md:col-span-2">
					{#if project && project.staged > 0}
						<span class="mr-auto text-xs text-muted-foreground">
							Deploying also deploys the {project.staged} other change{project.staged === 1
								? ''
								: 's'} staged in {project.environmentName}.
						</span>
					{/if}
					<Button
						type="submit"
						variant="outline"
						disabled={pending !== null || missing.length > 0 || (!project && !projectName.trim())}
					>
						{#if pending === 'add'}<Loader2Icon class="animate-spin" />{/if}
						Add to canvas
					</Button>
					<Button
						type="button"
						disabled={pending !== null || missing.length > 0 || (!project && !projectName.trim())}
						onclick={() => install(true)}
					>
						{#if pending === 'deploy'}<Loader2Icon class="animate-spin" />{/if}
						Deploy{project ? ` to ${project.environmentName}` : ''}
					</Button>
				</div>
			</form>
		{:else}
			<Dialog.Header>
				<Dialog.Title>Templates</Dialog.Title>
				<Dialog.Description>
					A whole stack at once: its services, volumes, references and generated secrets, wired up.
					{project ? 'It lands on this canvas' : 'It gets a project of its own'}, ready to review
					and deploy.
				</Dialog.Description>
			</Dialog.Header>
			{#if !templates}
				<div class="flex justify-center py-10"><Loader2Icon class="animate-spin" /></div>
			{:else}
				<div class="grid gap-3 py-2 sm:grid-cols-2" data-testid="template-gallery">
					{#each templates as t (t.id)}
						<button
							type="button"
							class="flex gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
							data-testid="template-card"
							onclick={() => (chosen = t.id)}
						>
							<TemplateIcon icon={t.icon} />
							<div class="min-w-0 space-y-1">
								<div class="font-medium">{t.name}</div>
								<div class="text-sm text-muted-foreground">{t.tagline}</div>
								<div class="flex flex-wrap items-center gap-1.5 pt-1 text-xs text-muted-foreground">
									<Badge variant="secondary"
										>{t.services.length} service{t.services.length === 1 ? '' : 's'}</Badge
									>
									<span>~{memory(t.requests.memoryMb)} memory</span>
									{#each t.tags.slice(0, 2) as tag (tag)}<span>· {tag}</span>{/each}
								</div>
							</div>
						</button>
					{/each}
				</div>
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>
