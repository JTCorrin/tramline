import { onMount } from 'svelte';

/**
 * False during server rendering and until the component mounts. Forms that
 * submit through JavaScript disable their button until then, so an early click
 * can't fall back to a plain HTML form submission.
 */
export function hydrated() {
	let ready = $state(false);
	onMount(() => {
		ready = true;
	});
	return {
		get current() {
			return ready;
		}
	};
}
