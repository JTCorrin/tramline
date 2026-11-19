import { toast } from 'svelte-sonner';

/**
 * Copies text to the clipboard and says whether it worked. Browsers only
 * offer `navigator.clipboard` on HTTPS or localhost, so an install reached
 * over plain HTTP (http://192.168.1.10:3000, say) falls back to the older
 * copy command on a hidden text field. If neither works, it says to copy
 * by hand instead of failing silently.
 */
export async function copyText(text: string, what = 'Copied') {
	if (await copied(text)) toast.success(what);
	else toast.error("Couldn't copy it here: select the text and copy it by hand");
}

async function copied(text: string) {
	if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// denied; try the fallback
		}
	}
	const field = document.createElement('textarea');
	field.value = text;
	field.setAttribute('readonly', '');
	field.style.position = 'fixed';
	field.style.opacity = '0';
	document.body.append(field);
	field.select();
	try {
		// deprecated, but the only way to copy outside a secure context
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		field.remove();
	}
}
