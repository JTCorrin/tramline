import { expect, test } from '@playwright/test';
import { INGRESS_PORT } from '../playwright.config';
import { createProject, signUp } from './helpers';

test.skip(process.env.TRAMLINE_E2E_DOCKER !== '1', 'needs Docker: set TRAMLINE_E2E_DOCKER=1');
// pulling images and starting containers takes a while on a cold machine
test.setTimeout(180_000);

test('deploy a Docker image, reach it through the ingress, then remove it', async ({
	page,
	request
}) => {
	await signUp(page);
	await createProject(page, 'Docker');
	await expect(page.getByTestId('node-status')).toContainText('1/1 node online', {
		timeout: 30_000
	});

	await page.keyboard.press('ControlOrMeta+k');
	await page.getByRole('option', { name: 'Docker Image' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Image').fill('traefik/whoami');
	await dialog.getByRole('button', { name: 'Add service' }).click();

	const panel = page.getByTestId('service-panel');
	await panel.getByRole('tab', { name: 'Settings' }).click();
	await page.getByLabel('Port').fill('80');
	await page.getByLabel('Port').press('Enter');
	await page.getByLabel('Healthcheck path').fill('/health');
	await page.getByLabel('Healthcheck path').press('Enter');
	await page.getByRole('switch', { name: 'Public domain' }).click();
	await page.getByTestId('changes-bar').getByRole('button', { name: 'Deploy' }).click();

	const node = page.getByTestId('service-node').filter({ hasText: 'whoami' });
	await expect(node).toContainText('Online', { timeout: 150_000 });

	// the generated URL routes through Caddy to the container
	const url = new URL(await page.getByTestId('service-url').innerText());
	expect(url.hostname).toMatch(/^whoami-[0-9a-f]{6}\.localhost$/);
	const response = await request.get(`http://127.0.0.1:${INGRESS_PORT}/`, {
		headers: { host: url.hostname }
	});
	expect(response.status()).toBe(200);
	expect(await response.text()).toContain('Hostname:');

	// logs stream into the deployments tab
	await panel.getByRole('tab', { name: 'Deployments' }).click();
	await expect(page.getByTestId('deployment-logs')).toContainText('Deployment is live');
	await expect(page.getByTestId('deployment-logs')).toContainText('Starting up on port 80', {
		timeout: 30_000
	});

	// removing tears the container down and the route with it
	await page.getByTestId('deployments').getByRole('button', { name: 'Remove' }).first().click();
	await expect(node).toContainText('Removed');
	await expect
		.poll(
			async () =>
				(
					await request.get(`http://127.0.0.1:${INGRESS_PORT}/`, {
						headers: { host: url.hostname }
					})
				).status(),
			{
				timeout: 30_000
			}
		)
		.toBe(404);
});
