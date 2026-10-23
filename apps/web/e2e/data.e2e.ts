import { INGRESS_PORT } from '../playwright.config';
import { createProject, expect, signUp, test, viaIngress } from './helpers';

test.skip(process.env.TRAMLINE_E2E_DOCKER !== '1', 'needs Docker: set TRAMLINE_E2E_DOCKER=1');
// two images to pull and scan, then a database to initialise
test.setTimeout(600_000);

const node = (page: import('@playwright/test').Page, name: string) =>
	page.getByTestId('service-node').filter({ hasText: name });

test('an app reaches Postgres through a reference, and the data survives a redeploy', async ({
	page,
	request
}) => {
	await signUp(page);
	await createProject(page, 'Data');
	await expect(page.getByTestId('node-status')).toContainText('1/1 node online', {
		timeout: 30_000
	});

	// Postgres comes with a volume for its data
	await page.locator('.svelte-flow__pane').click({ button: 'right', position: { x: 200, y: 200 } });
	await page.getByRole('menuitem', { name: 'Database' }).hover();
	await page.getByRole('menuitem', { name: 'PostgreSQL' }).click();
	await expect(node(page, 'postgres:17').getByTestId('volume-badge')).toBeVisible();
	const panel = page.getByTestId('service-panel');
	await panel.getByRole('tab', { name: 'Settings' }).click();
	await expect(page.getByLabel('Mount path')).toHaveValue('/var/lib/postgresql/data');

	// PostgREST serves the database over HTTP, connecting with Postgres's URL
	await page.keyboard.press('ControlOrMeta+k');
	await page.getByRole('option', { name: 'Docker Image' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Image').fill('postgrest/postgrest:v13.0.0');
	await dialog.getByRole('button', { name: 'Add service' }).click();
	await panel.getByRole('tab', { name: 'Variables' }).click();
	for (const [key, value] of [
		['PGRST_DB_URI', '${{Postgres.DATABASE_URL}}'],
		['PGRST_DB_ANON_ROLE', 'postgres'],
		['PGRST_SERVER_PORT', '3000']
	]) {
		await page.getByLabel('New variable key').fill(key!);
		await page.getByLabel('New variable value').fill(value!);
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		await expect(page.getByTestId('variables')).toContainText(key!);
	}
	await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
	await panel.getByRole('tab', { name: 'Settings' }).click();
	await page.getByLabel('Port', { exact: true }).fill('3000');
	await page.getByLabel('Port', { exact: true }).press('Enter');
	await page.getByRole('switch', { name: 'Public domain' }).click();
	await page.getByTestId('changes-bar').getByRole('button', { name: 'Deploy' }).click();

	await expect(node(page, 'postgres:17')).toContainText('Online', { timeout: 540_000 });
	const api = node(page, 'postgrest/postgrest');
	await expect(api).toContainText('Online', { timeout: 540_000 });

	// the app connected over the private network
	const url = new URL(await page.getByTestId('service-url').innerText());
	const ingress = () => viaIngress(request, INGRESS_PORT, url.hostname);
	await expect.poll(async () => (await ingress()).status, { timeout: 60_000 }).toBe(200);

	// redeploy Postgres: the old container stops, the new one finds the existing data
	await node(page, 'postgres:17').click();
	await panel.getByRole('tab', { name: 'Deployments' }).click();
	const logs = page.getByTestId('deployment-logs');
	await expect(logs).toContainText('database system is ready to accept connections', {
		timeout: 60_000
	});
	await page.getByTestId('deployments').getByRole('button', { name: 'Redeploy' }).click();
	await expect(page.getByTestId('deployments').locator('li')).toHaveCount(2);
	await expect(logs).toContainText('Skipping initialization', { timeout: 180_000 });
	await expect(node(page, 'postgres:17')).toContainText('Online', { timeout: 180_000 });
	await expect(page.getByTestId('deployments')).toContainText('Removed');

	// and the app reconnects to it
	await expect.poll(async () => (await ingress()).status, { timeout: 120_000 }).toBe(200);
});
