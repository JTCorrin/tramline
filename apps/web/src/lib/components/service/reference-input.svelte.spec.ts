import { describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ReferenceInput from './reference-input.svelte';

const suggestions = ['Postgres.DATABASE_URL', 'Postgres.PGHOST', 'shared.REGION', 'PORT'];

describe('ReferenceInput', () => {
	it('suggests references after ${{ and inserts the chosen one', async () => {
		render(ReferenceInput, { suggestions, 'aria-label': 'Value' });
		const input = page.getByRole('textbox', { name: 'Value' });

		await userEvent.type(input, 'url=${{{{post');
		const options = page.getByRole('option');
		await expect.element(options.first()).toHaveTextContent('Postgres.DATABASE_URL');
		expect(options.elements()).toHaveLength(2);

		await userEvent.keyboard('{ArrowDown}{Enter}');
		await expect.element(input).toHaveValue('url=${{Postgres.PGHOST}}');
		expect(page.getByRole('option').elements()).toHaveLength(0);
	});

	it('shows nothing outside a reference', async () => {
		render(ReferenceInput, { suggestions, 'aria-label': 'Plain' });
		await userEvent.type(page.getByRole('textbox', { name: 'Plain' }), 'hello');
		expect(page.getByRole('option').elements()).toHaveLength(0);
	});
});
