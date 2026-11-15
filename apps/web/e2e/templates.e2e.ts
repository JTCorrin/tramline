import type { Page } from '@playwright/test';
import { createProject, expect, signUp, test } from './helpers';

const node = (page: Page, name: string) =>
	page.getByTestId('service-node').filter({ hasText: name });

test('a new project from a template lands on its canvas, staged, with its notes', async ({
	page
}) => {
	await signUp(page);
	await page.getByRole('button', { name: 'From a template', exact: true }).click();
	const dialog = page.getByTestId('template-dialog');
	const gallery = dialog.getByTestId('template-gallery');
	await expect(gallery.getByTestId('template-card')).toHaveCount(3);
	await gallery.getByTestId('template-card').filter({ hasText: 'n8n' }).click();

	// what it adds, before it's added
	await expect(dialog.getByTestId('template-services')).toContainText('n8n');
	await expect(dialog.getByTestId('template-services')).toContainText('postgres');
	await expect(dialog.getByLabel('Project name')).toHaveValue('n8n');
	await dialog.getByLabel('Project name').fill('Automation');
	await dialog.getByLabel(/Time zone/).fill('Europe/London');
	await dialog.getByRole('button', { name: 'Add to canvas' }).click();

	await expect(dialog.getByTestId('template-notes')).toContainText('create the owner account');
	await dialog.getByRole('button', { name: 'Open project' }).click();
	await expect(page).toHaveTitle('Automation · Tramline');
	await expect(node(page, 'n8n')).toContainText('staged');
	await expect(node(page, 'postgres')).toContainText('staged');
	// n8n references its database, which draws an edge
	await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
	await expect(page.getByTestId('changes-bar')).toContainText('Apply 2 changes');

	// the encryption key was generated and sealed
	await node(page, 'n8n').click();
	await page.getByTestId('service-panel').getByRole('tab', { name: 'Variables' }).click();
	const key = page.getByTestId('variables').locator('li').filter({ hasText: 'N8N_ENCRYPTION_KEY' });
	await expect(key).toContainText(/sealed/i);
	await expect(page.getByTestId('variables')).toContainText('Europe/London');
});

test('an empty canvas offers templates, and the palette lists them by name', async ({ page }) => {
	await signUp(page);
	await createProject(page, 'Status');
	await page
		.getByTestId('empty-canvas')
		.getByRole('button', { name: 'Start from a template' })
		.click();
	const dialog = page.getByTestId('template-dialog');
	await expect(dialog.getByTestId('template-gallery')).toBeVisible();
	await page.keyboard.press('Escape');

	await page.keyboard.press('ControlOrMeta+k');
	await page.getByRole('option', { name: /Uptime Kuma/ }).click();
	await expect(dialog).toContainText('Uptime monitoring with a status page');
	await dialog.getByRole('button', { name: 'Add to canvas' }).click();
	await expect(dialog.getByTestId('template-notes')).toBeVisible();
	await dialog.getByRole('button', { name: 'Done' }).click();
	await expect(node(page, 'uptime-kuma')).toContainText('staged');
	await expect(page.getByTestId('changes-bar')).toContainText('Apply 1 change');
});
