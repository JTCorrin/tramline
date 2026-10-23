import { expect, type Page } from '@playwright/test';

/** Signs up a fresh user, creates an organization and lands on the dashboard. */
export async function signUp(page: Page, org = 'E2E Org') {
	await page.goto('/sign-up');
	await page.getByLabel('Name').fill('E2E Tester');
	await page.getByLabel('Email').fill(`e2e-${crypto.randomUUID()}@tramline.test`);
	await page.getByLabel('Password').fill('e2e-password-1234');
	await page.getByRole('button', { name: 'Create account' }).click();
	await expect(page).toHaveURL(/\/onboarding$/);
	await page.getByLabel('Organization name').fill(org);
	await page.getByRole('button', { name: 'Create organization' }).click();
	await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
}

/** Creates a project from the dashboard and opens its canvas. */
export async function createProject(page: Page, name: string) {
	await page.getByRole('button', { name: 'New project' }).click();
	await page.getByLabel('Name').fill(name);
	await page.getByRole('button', { name: 'Create project' }).click();
	await page.getByTestId('project-card').filter({ hasText: name }).getByRole('link').click();
	await expect(page).toHaveTitle(`${name} · Tramline`);
	await expect(page.getByTestId('environment-switcher')).toContainText('production');
}
