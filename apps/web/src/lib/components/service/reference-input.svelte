<script lang="ts">
	import { Input } from '#lib/components/ui/input/index.js';
	import { cn } from '#lib/utils.js';

	let {
		value = $bindable(''),
		suggestions,
		class: className,
		...rest
	}: {
		value?: string;
		/** e.g. `Postgres.DATABASE_URL`, `shared.REGION`, `PORT` */
		suggestions: string[];
		class?: string;
		id?: string;
		placeholder?: string;
		'aria-label'?: string;
		onkeydown?: (event: KeyboardEvent) => void;
	} = $props();

	let input = $state<HTMLInputElement | null>(null);
	let focused = $state(false);
	let active = $state(0);

	// the unfinished `${{ partial` right before the end of the value
	const partial = $derived(/\$\{\{\s*([\w.-]*)$/.exec(value)?.[1]);
	const matches = $derived(
		partial === undefined
			? []
			: suggestions.filter((s) => s.toLowerCase().includes(partial.toLowerCase())).slice(0, 8)
	);
	const open = $derived(focused && matches.length > 0);

	function pick(suggestion: string) {
		value = value.replace(/\$\{\{\s*[\w.-]*$/, `\${{${suggestion}}}`);
		active = 0;
		input?.focus();
	}

	function keydown(event: KeyboardEvent) {
		if (open) {
			if (event.key === 'ArrowDown') active = (active + 1) % matches.length;
			else if (event.key === 'ArrowUp') active = (active - 1 + matches.length) % matches.length;
			else if (event.key === 'Enter' || event.key === 'Tab') pick(matches[active]!);
			else return rest.onkeydown?.(event);
			event.preventDefault();
			return;
		}
		rest.onkeydown?.(event);
	}
</script>

<div class="relative">
	<Input
		bind:ref={input}
		bind:value
		id={rest.id}
		placeholder={rest.placeholder}
		aria-label={rest['aria-label']}
		autocomplete="off"
		class={cn('font-mono text-xs', className)}
		onfocus={() => (focused = true)}
		onblur={() => setTimeout(() => (focused = false), 100)}
		onkeydown={keydown}
	/>
	{#if open}
		<ul
			class="absolute top-full z-50 mt-1 w-full overflow-hidden rounded-md border bg-popover py-1 text-xs shadow-md"
			role="listbox"
		>
			{#each matches as suggestion, i (suggestion)}
				<li>
					<button
						type="button"
						role="option"
						aria-selected={i === active}
						class={cn('w-full px-3 py-1.5 text-left font-mono', i === active && 'bg-accent')}
						onmousedown={(event) => {
							event.preventDefault();
							pick(suggestion);
						}}
					>
						{suggestion}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
