import { INGRESS_PORT } from '../playwright.config';
import { createProject, expect, signUp, test, viaIngress } from './helpers';

test.skip(process.env.TRAMLINE_E2E_DOCKER !== '1', 'needs Docker: set TRAMLINE_E2E_DOCKER=1');
// pulling, scanning (the first scan downloads Trivy's database) and starting containers
// takes a while on a cold machine
test.setTimeout(600_000);

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
	await expect(node).toContainText('Online', { timeout: 540_000 });

	// the generated URL routes through Caddy to the container
	const url = new URL(await page.getByTestId('service-url').innerText());
	expect(url.hostname).toMatch(/^whoami-[0-9a-f]{6}\.localhost$/);
	// the ingress picks up new routes within a second or two
	const ingress = () => viaIngress(request, INGRESS_PORT, url.hostname);
	await expect.poll(async () => (await ingress()).status, { timeout: 15_000 }).toBe(200);
	expect((await ingress()).text).toContain('Hostname:');

	// a custom domain (.localhost names need no DNS proof) routes to the same deployment
	await panel.getByRole('tab', { name: 'Settings' }).click();
	const domains = page.getByTestId('custom-domains');
	await domains.getByLabel('Custom domain').fill('whoami-shop.localhost');
	await domains.getByRole('button', { name: 'Add' }).click();
	await expect(domains.getByTestId('custom-domain')).toContainText('Verified');
	const custom = () => viaIngress(request, INGRESS_PORT, 'whoami-shop.localhost');
	await expect.poll(async () => (await custom()).status, { timeout: 15_000 }).toBe(200);
	expect((await custom()).text).toContain('Hostname:');

	// logs stream into the deployments tab
	await panel.getByRole('tab', { name: 'Deployments' }).click();
	await expect(page.getByTestId('deployment-logs')).toContainText('Deployment is live');
	// the image was scanned before it ran (warn mode: findings shown, deployed anyway)
	await expect(page.getByTestId('deployment-logs')).toContainText(
		'Scanning for vulnerabilities with Trivy'
	);
	await expect(page.getByTestId('scan-summary').first()).toBeVisible();
	await expect(page.getByTestId('deployment-logs')).toContainText('Starting up on port 80', {
		timeout: 30_000
	});

	// removing tears the container down and the route with it
	await page.getByTestId('deployments').getByRole('button', { name: 'Remove' }).first().click();
	await expect(node).toContainText('Removed');
	await expect.poll(async () => (await ingress()).status, { timeout: 30_000 }).toBe(404);
});
