import type { Page } from '@playwright/test';
import { createProject, signUp, expect, test } from './helpers';

const node = (page: Page, name: string) =>
	page.getByTestId('service-node').filter({ hasText: name });
const changesBar = (page: Page) => page.getByTestId('changes-bar');
const panel = (page: Page) => page.getByTestId('service-panel');
/** Any status after Deploy; how far it gets depends on whether an agent is running. */
const DEPLOYED = /Queued|Building|Deploying|Online/;

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
	// queued without an agent; further along when one is running (TRAMLINE_E2E_DOCKER=1)
	await expect(node(page, 'whoami')).toContainText(DEPLOYED);
	await expect(node(page, 'Postgres')).toContainText(DEPLOYED);
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
	await expect(node(page, 'Redis')).toContainText(DEPLOYED);

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
	await expect(node(page, 'Redis')).toContainText(DEPLOYED);
	await changesBar(page).getByRole('button', { name: 'Details' }).click();
	await expect(page.getByText('+ REGION')).toBeVisible();
	await page.keyboard.press('Escape');

	// duplicating production brings its variables along
	await page.getByTestId('environment-switcher').click();
	await page.getByRole('menuitem', { name: 'New environment' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Name').fill('qa');
	await dialog.getByRole('combobox', { name: 'Start from' }).click();
	await page.getByRole('option', { name: 'A copy of production' }).click();
	await expect(dialog).toContainText('Databases get new credentials');
	await dialog.getByRole('button', { name: 'Create environment' }).click();
	await expect(page.getByTestId('environment-switcher')).toContainText('qa');
	await page.getByRole('button', { name: 'Shared variables' }).click();
	await expect(page.getByRole('dialog').getByTestId('variables')).toContainText('REGION');
});

test('seal a variable so its value can never be shown again', async ({ page }) => {
	await page.keyboard.press('ControlOrMeta+k');
	await page.getByRole('option', { name: 'Empty Service' }).click();
	await panel(page).getByRole('tab', { name: 'Variables' }).click();
	await page.getByLabel('New variable key').fill('API_KEY');
	await page.getByLabel('New variable value').fill('sk_live_supersecret');
	await page.getByRole('button', { name: 'Add', exact: true }).click();

	const vars = page.getByTestId('variables');
	await vars.getByRole('button', { name: 'Show API_KEY' }).click();
	await expect(vars).toContainText('sk_live_supersecret');

	await vars.getByRole('button', { name: 'Seal API_KEY' }).click();
	await page.getByRole('button', { name: 'Seal variable' }).click();
	await expect(vars).toContainText('sealed');
	await expect(vars).not.toContainText('sk_live_supersecret');
	await expect(vars.getByRole('button', { name: 'Show API_KEY' })).toHaveCount(0);
	await expect(vars.getByRole('button', { name: 'Seal API_KEY' })).toHaveCount(0);

	// not in the raw editor either, and the API never returns it
	await page.getByRole('button', { name: 'Raw editor' }).click();
	await expect(page.locator('textarea')).not.toHaveValue(/supersecret/);
	await page.getByRole('button', { name: 'Table view' }).click();
	const api = await page.evaluate(async () => {
		const service = new URL(location.href).searchParams.get('service');
		const envs = await (
			await fetch(`/api/v1/environments?projectId=${location.pathname.split('/').pop()}`)
		).json();
		return (
			await fetch(`/api/v1/variables?environmentId=${envs[0].id}&serviceId=${service}`)
		).text();
	});
	expect(api).not.toContain('supersecret');
	expect(JSON.parse(api)).toEqual([{ key: 'API_KEY', value: null, sealed: true, staged: 'added' }]);

	// replacing it keeps it sealed
	await vars.getByRole('button', { name: 'Edit API_KEY' }).click();
	await page.getByLabel('Value of API_KEY').fill('sk_live_rotated');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(vars).toContainText('sealed');
	await expect(vars).not.toContainText('sk_live_rotated');
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
