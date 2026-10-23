<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { api } from '#lib/api.js';
	import { reportError } from '#lib/forms.js';
	import { cn } from '#lib/utils.js';
	import LockIcon from '@lucide/svelte/icons/lock';
	import type { GitHubRepo, ServiceSource } from '@tramline/contracts';

	let {
		kind = $bindable(),
		oncreate
	}: {
		/** Open while set. */
		kind: 'image' | 'repo' | undefined;
		oncreate: (source: ServiceSource) => Promise<unknown>;
	} = $props();

	let image = $state('');
	let repo = $state('');
	let branch = $state('main');
	let pending = $state(false);
	/** Repositories from connected GitHub installations; loaded when the dialog opens for a repo. */
	let repos = $state<GitHubRepo[]>([]);
	let filter = $state('');
	let picked = $state<GitHubRepo | null>(null);

	$effect(() => {
		if (kind !== 'repo') return;
		api()
			.github.repos()
			.then((list) => (repos = list))
			// no GitHub connection yet: public URLs still work
			.catch(() => (repos = []));
	});

	const shown = $derived(
		repos.filter((r) => r.fullName.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 8)
	);

	function pick(r: GitHubRepo) {
		picked = r;
		repo = r.url;
		branch = r.defaultBranch;
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		pending = true;
		try {
			await oncreate(
				kind === 'image'
					? { type: 'image', image }
					: {
							type: 'repo',
							repo,
							branch,
							rootDirectory: '/',
							installationId: picked?.url === repo ? picked.installationId : null,
							autoDeploy: true
						}
			);
			kind = undefined;
			image = repo = filter = '';
			branch = 'main';
			picked = null;
		} catch (error) {
			reportError(error);
		} finally {
			pending = false;
		}
	}
</script>

<Dialog.Root bind:open={() => kind !== undefined, (open) => !open && (kind = undefined)}>
	<Dialog.Content class="sm:max-w-md">
		<form onsubmit={submit}>
			<Dialog.Header>
				<Dialog.Title
					>{kind === 'image' ? 'Deploy a Docker image' : 'Deploy a Git repository'}</Dialog.Title
				>
				<Dialog.Description>
					{kind === 'image'
						? 'Any public image, e.g. nginx, ghcr.io/org/app:1.2'
						: 'Builds with Railpack, or your Dockerfile when the repository has one.'}
				</Dialog.Description>
			</Dialog.Header>
			<Field.Group class="py-4">
				{#if kind === 'image'}
					<Field.Field>
						<Field.Label for="new-source-image">Image</Field.Label>
						<Input id="new-source-image" placeholder="traefik/whoami" required bind:value={image} />
					</Field.Field>
				{:else}
					{#if repos.length}
						<Field.Field>
							<Field.Label for="new-source-search">Your GitHub repositories</Field.Label>
							<Input id="new-source-search" placeholder="Search" bind:value={filter} />
							<ul
								class="max-h-56 divide-y overflow-auto rounded-md border"
								data-testid="github-repos"
							>
								{#each shown as r (r.fullName)}
									<li>
										<button
											type="button"
											class={cn(
												'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent',
												picked?.fullName === r.fullName && 'bg-accent'
											)}
											onclick={() => pick(r)}
										>
											{r.fullName}
											{#if r.private}<LockIcon
													class="size-3 text-muted-foreground"
													aria-label="Private"
												/>{/if}
										</button>
									</li>
								{/each}
							</ul>
							<Field.Description>Or paste the URL of any public repository below.</Field.Description
							>
						</Field.Field>
					{/if}
					<Field.Field>
						<Field.Label for="new-source-repo">Repository</Field.Label>
						<Input
							id="new-source-repo"
							placeholder="https://github.com/acme/api"
							required
							bind:value={repo}
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="new-source-branch">Branch</Field.Label>
						<Input id="new-source-branch" required bind:value={branch} />
					</Field.Field>
				{/if}
			</Field.Group>
			<Dialog.Footer>
				<Button type="submit" disabled={pending}>Add service</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
