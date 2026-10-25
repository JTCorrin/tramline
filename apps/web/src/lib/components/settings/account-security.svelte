<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { authClient } from '#lib/auth-client.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { timeAgo } from '#lib/format.js';
	import { toast } from 'svelte-sonner';
	import { encode } from 'uqr';

	let { twoFactorEnabled }: { twoFactorEnabled: boolean } = $props();

	type Passkey = { id: string; name?: string | null; createdAt?: Date | string | null };

	let password = $state('');
	let code = $state('');
	let enrolling = $state<{ uri: string; secret: string; backupCodes: string[] } | null>(null);
	let confirmed = $state(false);
	let error = $state('');
	let passkeys = $state<Passkey[]>([]);
	let passkeyName = $state('');

	const loadPasskeys = () =>
		authClient.passkey
			.listUserPasskeys()
			.then((result) => (passkeys = (result.data ?? []) as Passkey[]));

	$effect(() => {
		void loadPasskeys();
	});

	async function start(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		const result = await authClient.twoFactor.enable({ password });
		if (result.error) {
			error = result.error.message ?? 'Could not start';
			return;
		}
		if (result.data.method !== 'totp') {
			error = 'Your account uses email codes instead';
			return;
		}
		const uri = result.data.totpURI;
		enrolling = {
			uri,
			secret: new URL(uri).searchParams.get('secret') ?? '',
			backupCodes: result.data.backupCodes
		};
		password = '';
	}

	/** The QR code's dark modules, drawn as SVG rects rather than injected markup. */
	const qr = $derived(enrolling ? encode(enrolling.uri, { border: 1 }) : null);

	async function confirm(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		const result = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, '') });
		if (result.error) {
			error = result.error.message ?? 'That code is not right';
			return;
		}
		confirmed = true;
		code = '';
		toast.success('Two-factor authentication is on');
	}

	async function finish() {
		enrolling = null;
		confirmed = false;
		await invalidateAll();
	}

	async function disable(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		const result = await authClient.twoFactor.disable({ password });
		if (result.error) {
			error = result.error.message ?? 'Could not turn it off';
			return;
		}
		password = '';
		toast.success('Two-factor authentication is off');
		await invalidateAll();
	}

	async function addPasskey(event: SubmitEvent) {
		event.preventDefault();
		const result = await authClient.passkey.addPasskey({ name: passkeyName || undefined });
		if (result?.error) {
			toast.error(result.error.message ?? 'Could not add the passkey');
			return;
		}
		passkeyName = '';
		toast.success('Passkey added');
		await loadPasskeys();
	}

	async function removePasskey(passkey: Passkey) {
		const result = await authClient.passkey.deletePasskey({ id: passkey.id });
		if (result.error) {
			toast.error(result.error.message ?? 'Could not remove the passkey');
			return;
		}
		await loadPasskeys();
	}
</script>

<Card.Root data-testid="account-security">
	<Card.Header>
		<Card.Title>Your account’s security</Card.Title>
		<Card.Description>
			Protect your sign-in with an authenticator app, or sign in with a passkey instead of a
			password.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-6">
		<section class="space-y-3" data-testid="two-factor">
			<div class="text-sm font-medium">
				Two-factor authentication
				<span
					class={twoFactorEnabled
						? 'text-emerald-600 dark:text-emerald-400'
						: 'text-muted-foreground'}
				>
					· {twoFactorEnabled ? 'on' : 'off'}
				</span>
			</div>
			{#if enrolling}
				{#if !confirmed}
					<div class="flex flex-wrap items-start gap-4">
						{#if qr}
							<svg
								class="size-40 rounded-md bg-white"
								viewBox="0 0 {qr.size} {qr.size}"
								shape-rendering="crispEdges"
								role="img"
								aria-label="QR code for your authenticator app"
							>
								{#each qr.data as row, y (y)}
									{#each row as dark, x (x)}
										{#if dark}<rect {x} {y} width="1" height="1" fill="black" />{/if}
									{/each}
								{/each}
							</svg>
						{/if}
						<div class="min-w-0 flex-1 space-y-2 text-sm">
							<p>Scan the code with an authenticator app, or enter this key:</p>
							<code class="block font-mono text-xs break-all" data-testid="totp-secret"
								>{enrolling.secret}</code
							>
							<form class="flex gap-2" onsubmit={confirm}>
								<Input
									aria-label="Code from your app"
									inputmode="numeric"
									autocomplete="one-time-code"
									placeholder="123456"
									bind:value={code}
									required
								/>
								<Button type="submit">Confirm</Button>
							</form>
						</div>
					</div>
				{:else}
					<div class="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
						<p class="font-medium">
							Save these backup codes somewhere safe. Each signs you in once if you lose your app.
						</p>
						<pre class="font-mono text-xs" data-testid="backup-codes">{enrolling.backupCodes.join(
								'\n'
							)}</pre>
						<Button size="sm" onclick={finish}>I’ve saved them</Button>
					</div>
				{/if}
			{:else}
				<form class="flex gap-2" onsubmit={twoFactorEnabled ? disable : start}>
					<Input
						type="password"
						aria-label="Your password"
						placeholder="Your password"
						autocomplete="current-password"
						bind:value={password}
						required
					/>
					<Button type="submit" variant={twoFactorEnabled ? 'outline' : 'default'}>
						{twoFactorEnabled ? 'Turn off' : 'Turn on'}
					</Button>
				</form>
			{/if}
			{#if error}<Field.Error>{error}</Field.Error>{/if}
		</section>

		<section class="space-y-3" data-testid="passkeys">
			<div class="text-sm font-medium">Passkeys</div>
			{#if passkeys.length}
				<ul class="divide-y rounded-lg border text-sm">
					{#each passkeys as passkey (passkey.id)}
						<li class="flex items-center gap-3 px-3 py-2">
							<span class="flex-1">{passkey.name || 'Passkey'}</span>
							{#if passkey.createdAt}
								<span class="text-xs text-muted-foreground"
									>added {timeAgo(new Date(passkey.createdAt).toISOString())}</span
								>
							{/if}
							<Button variant="ghost" size="sm" onclick={() => removePasskey(passkey)}
								>Remove</Button
							>
						</li>
					{/each}
				</ul>
			{/if}
			<form class="flex gap-2" onsubmit={addPasskey}>
				<Input aria-label="Passkey name" placeholder="e.g. MacBook" bind:value={passkeyName} />
				<Button type="submit" variant="outline">Add a passkey</Button>
			</form>
		</section>
	</Card.Content>
</Card.Root>
