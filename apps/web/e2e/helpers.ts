import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';

export { expect };

/** Every UI test fails if the browser reports a Content Security Policy violation. */
export const test = base.extend<{ cspGuard: void }>({
	cspGuard: [
		async ({ page }, use) => {
			const violations: string[] = [];
			page.on('console', (message) => {
				if (message.type() === 'error' && message.text().includes('Content Security Policy')) {
					violations.push(message.text());
				}
			});
			await use();
			expect(violations, 'CSP violations').toEqual([]);
		},
		{ auto: true }
	]
});

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

/**
 * GET through the ingress with the service's hostname. Each deploy reloads
 * Caddy, which closes idle keep-alive connections; like a browser, retry a
 * reset connection instead of failing. Returns status 0 if it never connects.
 */
export async function viaIngress(request: APIRequestContext, port: number, host: string) {
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await request.get(`http://127.0.0.1:${port}/`, { headers: { host } });
			return { status: response.status(), text: await response.text() };
		} catch (error) {
			if (attempt >= 3) return { status: 0, text: String(error) };
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
}
