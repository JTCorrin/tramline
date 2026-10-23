import { expect, test } from '@playwright/test';

test('sign up, create an organization and manage projects', async ({ page }) => {
	const email = `e2e-${Date.now()}@tramline.test`;

	await page.goto('/');
	await expect(page).toHaveURL(/\/sign-in$/);

	await page.getByRole('link', { name: 'Create one' }).click();
	await page.getByLabel('Name').fill('E2E Tester');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill('e2e-password-1234');
	await page.getByRole('button', { name: 'Create account' }).click();

	await expect(page).toHaveURL(/\/onboarding$/);
	await page.getByLabel('Organization name').fill('E2E Org');
	await page.getByRole('button', { name: 'Create organization' }).click();

	await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();

	// create
	await page.getByRole('button', { name: 'New project' }).click();
	await page.getByLabel('Name').fill('Storefront');
	await page.getByLabel('Description').fill('Shop backend');
	await page.getByRole('button', { name: 'Create project' }).click();
	const card = page.getByTestId('project-card');
	await expect(card).toContainText('Storefront');
	await expect(card).toContainText('Shop backend');

	// rename
	await card.getByRole('button', { name: 'Project actions' }).click();
	await page.getByRole('menuitem', { name: 'Settings' }).click();
	await page.getByLabel('Name').fill('Storefront v2');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(card).toContainText('Storefront v2');

	// survives a reload, i.e. it really reached the API
	await page.reload();
	await expect(card).toContainText('Storefront v2');

	// open the project
	await card.getByRole('link', { name: 'Storefront v2' }).click();
	await expect(page).toHaveTitle('Storefront v2 · Tramline');
	await page.goBack();

	// delete
	await card.getByRole('button', { name: 'Project actions' }).click();
	await page.getByRole('menuitem', { name: 'Delete' }).click();
	await page.getByRole('button', { name: 'Delete project' }).click();
	await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
});

test('the API rejects unauthenticated requests with the error envelope', async ({ request }) => {
	const response = await request.get('/api/v1/projects');
	expect(response.status()).toBe(401);
	expect(await response.json()).toEqual({
		error: { code: 'unauthenticated', message: 'You need to sign in' }
	});
});
