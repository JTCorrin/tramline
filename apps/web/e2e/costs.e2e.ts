import { ALL_NODES_ONLINE, becomeInstallAdmin, createProject, expect, test } from './helpers';

test.skip(process.env.TRAMLINE_E2E_DOCKER !== '1', 'needs Docker: set TRAMLINE_E2E_DOCKER=1');
test.setTimeout(300_000);

test("a service's monthly cost is its share of the node it runs on", async ({ page }) => {
	await becomeInstallAdmin(page);
	await page.goto('/nodes');

	// the local machine has no provider to price it, so say what it costs
	const local = page.locator('[data-testid="node-row"][data-node="local"]');
	await local.getByLabel('Monthly cost').fill('40');
	await local.getByRole('button', { name: 'Save cost' }).click();
	await expect(local.getByTestId('node-cost')).toHaveText('· $40/mo (entered)');

	try {
		await page.goto('/');
		await createProject(page, 'Costs');
		await expect(page.getByTestId('node-status')).toHaveText(ALL_NODES_ONLINE, {
			timeout: 30_000
		});
		await page.keyboard.press('ControlOrMeta+k');
		await page.getByRole('option', { name: 'Docker Image' }).click();
		const dialog = page.getByRole('dialog');
		await dialog.getByLabel('Image').fill('busybox:1.37.0');
		await dialog.getByRole('button', { name: 'Add service' }).click();

		const panel = page.getByTestId('service-panel');
		await panel.getByRole('tab', { name: 'Settings' }).click();
		await page.getByLabel('Start command').fill('sleep 3600');
		await page.getByLabel('Start command').press('Enter');
		await page.getByLabel('CPU request').fill('0.05');
		await page.getByLabel('CPU request').press('Enter');
		await page.getByRole('combobox', { name: 'Vulnerability scan' }).click();
		await page.getByRole('option', { name: 'Off' }).click();
		await page.getByLabel('Run on').click();
		await page.getByRole('option', { name: 'local', exact: true }).click();
		await page.getByTestId('changes-bar').getByRole('button', { name: 'Deploy' }).click();

		// a twentieth of a core of however many the node has: some cents of the $40
		const cost = page.getByTestId('environment-cost');
		await expect(cost).toHaveText(/≈ \$\d+\.\d\d\/mo/, { timeout: 120_000 });
		await cost.click();
		await expect(page.getByTestId('service-costs')).toContainText(/busybox\s*\$\d+\.\d\d\/mo/);
		// spend is added up every few minutes, so a new service has spent nothing yet
		await expect(page.getByTestId('environment-spent')).toContainText('Spent this month');
	} finally {
		await page.goto('/nodes');
		await local.getByLabel('Monthly cost').fill('');
		await local.getByRole('button', { name: 'Save cost' }).click();
		await expect(local.getByTestId('node-cost')).toHaveCount(0);
	}
});
