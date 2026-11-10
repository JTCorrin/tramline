import { becomeInstallAdmin, expect, test } from './helpers';

// the e2e server offers the in-memory fake adapter (TRAMLINE_FAKE_ADAPTER=1)
test('connect a compute account, test it, and create a machine with it', async ({ page }) => {
	await becomeInstallAdmin(page);
	const accounts = page.getByTestId('compute-accounts');
	await accounts.getByRole('button', { name: 'Connect an account' }).click();
	await accounts.getByRole('combobox', { name: 'Provider' }).click();
	await page.getByRole('option', { name: 'Fake cloud' }).click();
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
	// a GPU machine says what it costs before it's made
	const asked = new Promise<string>((resolve) =>
		page.once('dialog', (dialog) => {
			resolve(dialog.message());
			void dialog.accept();
		})
	);
	await add.getByRole('button', { name: 'Create machine' }).click();
	expect(await asked).toContain('costs $0.80 an hour (about $584 a month)');
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

test('the Proxmox form asks for what a cloud-init template clone needs', async ({ page }) => {
	await becomeInstallAdmin(page);
	const accounts = page.getByTestId('compute-accounts');
	await accounts.getByRole('button', { name: 'Connect an account' }).click();
	await accounts.getByRole('combobox', { name: 'Provider' }).click();
	await page.getByRole('option', { name: 'Proxmox VE' }).click();
	for (const label of [
		'Proxmox URL',
		'API token ID',
		'API token secret',
		'Certificate fingerprint',
		'CA certificate',
		'Template VM ID'
	]) {
		await expect(accounts.getByLabel(label, { exact: true })).toBeVisible();
	}
	await expect(accounts.getByLabel('API token secret')).toHaveAttribute('type', 'password');
	await accounts.getByRole('button', { name: 'Cancel' }).click();
});

test('a cloud-init seed answers without a session, and only with a valid ID', async ({
	request
}) => {
	const res = await request.get('/api/agent/v1/seed/not-a-real-seed/user-data');
	expect(res.status()).toBe(404);
	expect(res.headers()['content-type']).toContain('text/plain');
});

test('compare where a workload could run, then create the cheapest machine for it', async ({
	page
}) => {
	await becomeInstallAdmin(page);
	const connected = await page.request.post('/api/v1/adapter-accounts', {
		data: {
			adapter: 'fake',
			name: 'Fake prices',
			credentials: { apiToken: 'fake-token', project: 'prices' }
		}
	});
	expect(connected.ok(), await connected.text()).toBe(true);
	const { id: accountId } = (await connected.json()) as { id: string };
	await page.reload();

	const compare = page.getByTestId('compare-prices');
	await compare.getByLabel('GPUs').fill('1');
	await compare.getByRole('combobox', { name: 'Account' }).click();
	await page.getByRole('option', { name: 'Fake prices' }).click();
	await compare.getByRole('combobox', { name: 'Region' }).click();
	await page.getByRole('option', { name: 'Fake Region 1' }).click();
	await compare.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(compare.getByTestId('compared-regions')).toContainText('Fake prices · fake-1');

	// only the GPU size fits, at its monthly price; no node has a GPU free
	const offers = compare.getByTestId('placement-offer');
	await expect(offers).toHaveCount(1);
	await expect(offers.first()).toContainText('GPU');
	await expect(offers.first().getByTestId('placement-monthly')).toHaveText('$584/mo');
	await expect(compare.getByTestId('placement-existing')).toHaveCount(0);

	// without the GPU the small size is cheapest, and cheaper still at spot prices
	await compare.getByLabel('GPUs').fill('0');
	await compare.getByRole('button', { name: 'Compare' }).click();
	await expect(offers.first()).toContainText('Small');
	await expect(offers.first().getByTestId('placement-monthly')).toHaveText('$7.30/mo');
	await compare.getByRole('switch', { name: 'Spot prices' }).click();
	await compare.getByRole('button', { name: 'Compare' }).click();
	await expect(offers.first().getByTestId('placement-monthly')).toContainText('$2.92/mo');

	// one click (and a name) creates it, after saying what it costs
	await offers.first().getByRole('button', { name: 'Create node' }).click();
	await compare.getByLabel('Node name').fill('cheap-e2e');
	const asked = new Promise<string>((resolve) =>
		page.once('dialog', (dialog) => {
			resolve(dialog.message());
			void dialog.accept();
		})
	);
	await compare.getByRole('button', { name: 'Create', exact: true }).click();
	expect(await asked).toContain('about $2.92 a month');
	const pending = page
		.getByTestId('add-node')
		.getByTestId('provisioning-node')
		.filter({ hasText: 'cheap-e2e' });
	await expect(pending).toContainText('Fake prices · small');

	// tidy up: the machine, then the account
	page.once('dialog', (dialog) => dialog.accept());
	await pending.getByRole('button', { name: 'Destroy' }).click();
	await expect(pending).toHaveCount(0);
	const removed = await page.request.delete(`/api/v1/adapter-accounts/${accountId}`);
	expect(removed.ok(), await removed.text()).toBe(true);
});
