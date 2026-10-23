import { expect, test, type Page } from '@playwright/test';
import { createProject, signUp } from './helpers';

const node = (page: Page, name: string) =>
	page.getByTestId('service-node').filter({ hasText: name });
const changesBar = (page: Page) => page.getByTestId('changes-bar');
const panel = (page: Page) => page.getByTestId('service-panel');

test.beforeEach(async ({ page }) => {
	await signUp(page);
	await createProject(page, 'Shop');
});

test('build a project on the canvas, wire a reference and deploy', async ({ page }) => {
	await expect(page.getByText('This project is empty')).toBeVisible();

	// right-click → Database → PostgreSQL
	await page.locator('.svelte-flow__pane').click({ button: 'right', position: { x: 200, y: 200 } });
	await page.getByRole('menuitem', { name: 'Database' }).hover();
	await page.getByRole('menuitem', { name: 'PostgreSQL' }).click();
	await expect(node(page, 'Postgres')).toContainText('postgres:17');
	await expect(node(page, 'Postgres')).toContainText('staged');
	await expect(changesBar(page)).toContainText('Apply 1 change');
	await expect(panel(page)).toContainText('Postgres');

	// ⌘K → Docker Image
	await page.keyboard.press('ControlOrMeta+k');
	await page.getByRole('option', { name: 'Docker Image' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Image').fill('traefik/whoami');
	await dialog.getByRole('button', { name: 'Add service' }).click();
	await expect(node(page, 'whoami')).toBeVisible();
	await expect(panel(page)).toContainText('whoami');

	// add a variable using reference autocomplete
	await panel(page).getByRole('tab', { name: 'Variables' }).click();
	await page.getByLabel('New variable key').fill('DATABASE_URL');
	await page.getByLabel('New variable value').pressSequentially('${{Postgres.DATA');
	await page.getByRole('option', { name: 'Postgres.DATABASE_URL' }).click();
	await expect(page.getByLabel('New variable value')).toHaveValue('${{Postgres.DATABASE_URL}}');
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByTestId('variables')).toContainText('DATABASE_URL');

	// the reference draws an edge between the two services
	await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);

	// details list what will change
	await expect(changesBar(page)).toContainText('Apply 2 changes');
	await changesBar(page).getByRole('button', { name: 'Details' }).click();
	await expect(page.getByText('+ DATABASE_URL').first()).toBeVisible();
	await page.keyboard.press('Escape');

	// deploy
	await changesBar(page).getByRole('button', { name: 'Deploy' }).click();
	await expect(changesBar(page)).toBeHidden();
	await expect(node(page, 'whoami')).toContainText('Queued');
	await expect(node(page, 'Postgres')).toContainText('Queued');
	await panel(page).getByRole('tab', { name: 'Deployments' }).click();
	await expect(page.getByTestId('deployments')).toContainText('traefik/whoami');

	// a deep link reopens the same service
	await page.reload();
	await expect(panel(page)).toContainText('whoami');
});

test('stage settings changes, then discard them', async ({ page }) => {
	await page.locator('.svelte-flow__pane').click({ button: 'right', position: { x: 200, y: 200 } });
	await page.getByRole('menuitem', { name: 'Empty Service' }).click();
	await expect(node(page, 'service')).toContainText('No source');
	await changesBar(page).getByRole('button', { name: 'Deploy' }).click();
	await expect(changesBar(page)).toBeHidden();

	await panel(page).getByRole('tab', { name: 'Settings' }).click();
	await page.getByLabel('Image').fill('nginx:1.27');
	await page.getByLabel('Image').press('Enter');
	await page.getByLabel('Replicas').fill('3');
	await page.getByLabel('Replicas').press('Enter');
	await page.getByRole('switch', { name: 'Public domain' }).click();

	await expect(changesBar(page)).toContainText('Apply 1 change');
	await changesBar(page).getByRole('button', { name: 'Details' }).click();
	await expect(page.getByText('deploy.replicas: 1 → 3')).toBeVisible();
	await expect(page.getByText('networking.publicDomain: false → true')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(node(page, 'service')).toContainText('nginx:1.27');

	await changesBar(page).getByRole('button', { name: 'Discard' }).click();
	await expect(changesBar(page)).toBeHidden();
	await expect(node(page, 'service')).toContainText('No source');
	await expect(page.getByLabel('Replicas')).toHaveValue('1');
});

test('environments and shared variables', async ({ page }) => {
	await page.keyboard.press('ControlOrMeta+k');
	await page.getByRole('option', { name: 'Redis' }).click();
	await expect(node(page, 'Redis')).toBeVisible();
	await changesBar(page).getByRole('button', { name: 'Deploy' }).click();
	await expect(node(page, 'Redis')).toContainText('Queued');

	// shared variables
	await page.getByRole('button', { name: 'Shared variables' }).click();
	const sheet = page.getByRole('dialog');
	await sheet.getByLabel('New variable key').fill('REGION');
	await sheet.getByLabel('New variable value').fill('eu-west');
	await sheet.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(sheet.getByTestId('variables')).toContainText('REGION');
	await page.keyboard.press('Escape');
	await expect(changesBar(page)).toContainText('Apply 1 change');

	// a new environment gets every service, not yet deployed
	await page.getByTestId('environment-switcher').click();
	await page.getByRole('menuitem', { name: 'New environment' }).click();
	await page.getByRole('dialog').getByLabel('Name').fill('staging');
	await page.getByRole('button', { name: 'Create environment' }).click();
	await expect(page.getByTestId('environment-switcher')).toContainText('staging');
	await expect(page).toHaveURL(/env=env_/);
	await expect(node(page, 'Redis')).toContainText('Not deployed');
	await expect(changesBar(page)).toContainText('Apply 1 change');

	// production still has its own pending shared variable
	await page.getByTestId('environment-switcher').click();
	await page.getByRole('menuitem', { name: 'production' }).click();
	await expect(node(page, 'Redis')).toContainText('Queued');
	await changesBar(page).getByRole('button', { name: 'Details' }).click();
	await expect(page.getByText('+ REGION')).toBeVisible();
});

test('delete a service from its context menu', async ({ page }) => {
	await page.locator('.svelte-flow__pane').click({ button: 'right', position: { x: 200, y: 200 } });
	await page.getByRole('menuitem', { name: 'Empty Service' }).click();
	await node(page, 'service').click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Delete service' }).click();
	await page.getByRole('button', { name: 'Delete service' }).click();
	await expect(node(page, 'service')).toHaveCount(0);
	await expect(page.getByText('This project is empty')).toBeVisible();
});
