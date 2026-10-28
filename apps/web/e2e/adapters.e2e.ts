import { becomeInstallAdmin, expect, test } from './helpers';

// the e2e server offers the in-memory fake adapter (TRAMLINE_FAKE_ADAPTER=1)
test('connect a compute account, test it, and create a machine with it', async ({ page }) => {
	await becomeInstallAdmin(page);
	const accounts = page.getByTestId('compute-accounts');
	await accounts.getByRole('button', { name: 'Connect an account' }).click();
	await accounts.getByLabel('Account name').fill('Fake lab');
	// the form is generated from the adapter's credentials schema
	await accounts.getByLabel('API token').fill('wrong-token');
	await accounts.getByRole('button', { name: 'Connect', exact: true }).click();
	const account = accounts.getByTestId('compute-account').filter({ hasText: 'Fake lab' });
	await expect(account).toContainText('Fake cloud · 0 nodes');

	await account.getByRole('button', { name: 'Test connection' }).click();
	await expect(page.getByText('Fake lab: The API token was rejected')).toBeVisible();

	// the saved token is never shown; a new one replaces it
	await account.getByRole('button', { name: 'Edit' }).click();
	await expect(accounts.getByLabel('API token')).toHaveValue('');
	await accounts.getByLabel('API token').fill('fake-token');
	await accounts.getByRole('button', { name: 'Save' }).click();
	await account.getByRole('button', { name: 'Test connection' }).click();
	await expect(page.getByText('Fake lab: connected')).toBeVisible();

	// a new machine on the account, with a GPU size
	await page.reload();
	const add = page.getByTestId('add-node');
	await add.getByRole('combobox', { name: 'Machine' }).click();
	await page.getByRole('option', { name: 'New machine on Fake lab' }).click();
	await add.getByLabel('Name').fill('gpu-e2e');
	await expect(add.getByRole('combobox', { name: 'Region' })).toHaveText('Fake Region 1');
	await add.getByRole('combobox', { name: 'Size' }).click();
	await page.getByRole('option', { name: /GPU · 8 vCPU · 64 GB · 1× NVIDIA L4/ }).click();
	await add.getByRole('button', { name: 'Create machine' }).click();
	const pending = add.getByTestId('provisioning-node').filter({ hasText: 'gpu-e2e' });
	await expect(pending).toContainText('Waiting to enroll');
	await expect(pending).toContainText('Fake lab · gpu');

	// an account with machines can't be removed; destroying the machine frees it
	page.once('dialog', (dialog) => dialog.accept());
	await account.getByRole('button', { name: 'Remove' }).click();
	await expect(page.getByText('Fake lab still has 1 node')).toBeVisible();
	page.once('dialog', (dialog) => dialog.accept());
	await pending.getByRole('button', { name: 'Destroy' }).click();
	await expect(pending).toHaveCount(0);
	page.once('dialog', (dialog) => dialog.accept());
	await account.getByRole('button', { name: 'Remove' }).click();
	await expect(account).toHaveCount(0);
});
