import { toast } from 'svelte-sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

afterEach(() => vi.restoreAllMocks());

describe('copyText', () => {
	it('uses the clipboard API where the page is a secure context', async () => {
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		const ok = vi.spyOn(toast, 'success');
		await copyText('tl_secret');
		expect(write).toHaveBeenCalledWith('tl_secret');
		expect(ok).toHaveBeenCalledWith('Copied');
	});

	it('falls back to the copy command over plain HTTP, leaving nothing behind', async () => {
		vi.spyOn(window, 'isSecureContext', 'get').mockReturnValue(false);
		const write = vi.spyOn(navigator.clipboard, 'writeText');
		const exec = vi.spyOn(document, 'execCommand').mockReturnValue(true);
		const ok = vi.spyOn(toast, 'success');
		await copyText('curl … | sh', 'Command copied');
		expect(write).not.toHaveBeenCalled();
		expect(exec).toHaveBeenCalledWith('copy');
		expect(ok).toHaveBeenCalledWith('Command copied');
		expect(document.querySelector('textarea')).toBeNull();
	});

	it('says to copy by hand when neither works', async () => {
		vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
		vi.spyOn(document, 'execCommand').mockReturnValue(false);
		const failed = vi.spyOn(toast, 'error');
		await copyText('x');
		expect(failed).toHaveBeenCalledWith(expect.stringContaining('copy it by hand'));
	});
});
