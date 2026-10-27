import { createProject, signUp, expect, test } from './helpers';

test('sign up, create an organization and manage projects', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/sign-in$/);
	await page.getByRole('link', { name: 'Create one' }).click();
	await expect(page).toHaveURL(/\/sign-up$/);

	await signUp(page);
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

	// delete
	await card.getByRole('button', { name: 'Project actions' }).click();
	await page.getByRole('menuitem', { name: 'Delete' }).click();
	await page.getByRole('button', { name: 'Delete project' }).click();
	await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
});

test('switches between organizations and projects', async ({ page }) => {
	await signUp(page, 'Alpha');
	await createProject(page, 'One');
	await page.goto('/');
	await createProject(page, 'Two');

	// project switcher in the header
	await page.getByRole('button', { name: 'Two', exact: true }).click();
	await page.getByRole('menuitem', { name: 'One' }).click();
	await expect(page).toHaveTitle('One · Tramline');

	// "New project" from the switcher opens the dialog on the dashboard
	await page.getByRole('button', { name: 'One', exact: true }).click();
	await page.getByRole('menuitem', { name: 'New project' }).click();
	await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
	await page.keyboard.press('Escape');

	// a second organization has its own, empty project list
	await page.getByRole('button', { name: 'Alpha' }).click();
	await page.getByRole('menuitem', { name: 'New organization' }).click();
	await page.getByLabel('Organization name').fill('Beta');
	await page.getByRole('button', { name: 'Create organization' }).click();
	await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();

	await page.getByRole('button', { name: 'Beta' }).click();
	await page.getByRole('menuitem', { name: 'Alpha' }).click();
	await expect(page.getByTestId('project-card')).toHaveCount(2);
});

test('pages and API responses carry security headers', async ({ request }) => {
	const page = await request.get('/sign-in');
	const csp = page.headers()['content-security-policy'];
	expect(csp).toMatch(/script-src 'self' 'nonce-[^']+'/);
	expect(csp).toContain("frame-ancestors 'none'");
	expect(page.headers()).toMatchObject({
		'x-content-type-options': 'nosniff',
		'x-frame-options': 'DENY',
		'referrer-policy': 'strict-origin-when-cross-origin'
	});
	expect((await request.get('/api/v1/projects')).headers()['x-content-type-options']).toBe(
		'nosniff'
	);
});

test('the API rejects unauthenticated requests with the error envelope', async ({ request }) => {
	const response = await request.get('/api/v1/projects');
	expect(response.status()).toBe(401);
	expect(await response.json()).toEqual({
		error: { code: 'unauthenticated', message: 'You need to sign in' }
	});
});

test('an invite link brings someone new straight into the organization', async ({
	page,
	browser
}) => {
	await signUp(page, 'Inviting Org');
	await createProject(page, 'Shared');
	await page.goto('/settings');
	const invites = page.getByTestId('invites');
	await invites.getByRole('button', { name: 'Create invite link' }).click();
	const link = await page.getByTestId('invite-link').inputValue();
	expect(link).toMatch(/\/invite\/tlinv_/);

	// someone else, signed out, opens it and signs up: no onboarding, already a member
	const guest = await browser.newContext();
	const other = await guest.newPage();
	await other.goto(link);
	await expect(other).toHaveURL(/\/sign-up$/);
	await other.getByLabel('Name').fill('Guest');
	await other.getByLabel('Email').fill(`guest-${crypto.randomUUID()}@tramline.test`);
	await other.getByLabel('Password').fill('e2e-password-1234');
	await other.getByRole('button', { name: 'Create account' }).click();
	await expect(other.getByRole('button', { name: 'Inviting Org' })).toBeVisible();
	await expect(other.getByTestId('project-card').filter({ hasText: 'Shared' })).toBeVisible();

	// the link is spent
	await other.goto(link);
	await expect(other.getByText("This invite can't be used")).toBeVisible();
	await guest.close();
});
