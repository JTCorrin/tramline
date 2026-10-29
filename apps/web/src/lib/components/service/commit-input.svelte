<script lang="ts">
	import { Input } from '#lib/components/ui/input/index.js';
	import { cn } from '#lib/utils.js';

	let {
		id,
		value,
		placeholder,
		type = 'text',
		step,
		mono = false,
		onsave
	}: {
		id: string;
		value: string | number | null;
		placeholder?: string;
		type?: 'text' | 'number';
		/** For number inputs; whole numbers unless set. */
		step?: string;
		mono?: boolean;
		/** Called on blur or Enter when the value changed; empty input saves null. */
		onsave: (value: string | null) => void;
	} = $props();

	const current = $derived(value === null ? '' : String(value));
	// what the user is typing; while set, refreshes of `value` don't clobber the input
	let draft = $state<string | null>(null);

	function commit() {
		const next = draft?.trim();
		draft = null;
		if (next !== undefined && next !== current) onsave(next || null);
	}
</script>

<Input
	{id}
	{type}
	{step}
	{placeholder}
	class={cn(mono && 'font-mono text-xs')}
	value={draft ?? current}
	onfocus={() => (draft = current)}
	oninput={(event) => (draft = event.currentTarget.value)}
	onblur={commit}
	onkeydown={(event) => {
		if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur();
		if (event.key === 'Escape') {
			draft = current;
			(event.currentTarget as HTMLInputElement).blur();
		}
	}}
/>
