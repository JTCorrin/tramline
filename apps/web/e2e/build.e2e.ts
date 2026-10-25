import { INGRESS_PORT } from '../playwright.config';
import { createProject, expect, signUp, test, viaIngress } from './helpers';

test.skip(process.env.TRAMLINE_E2E_DOCKER !== '1', 'needs Docker: set TRAMLINE_E2E_DOCKER=1');
// a cold Railpack build downloads Node and npm packages, and a cold builder
// downloads Trivy's vulnerability database before its first scan
test.setTimeout(720_000);

const REPO = 'https://github.com/heroku/nodejs-getting-started';

test('build a GitHub repository from source, serve it, and redeploy without rebuilding', async ({
	page,
	request
}) => {
	await signUp(page);
	await createProject(page, 'Source');
	await expect(page.getByTestId('node-status')).toContainText('1/1 node online', {
		timeout: 30_000
	});

	await page.keyboard.press('ControlOrMeta+k');
	await page.getByRole('option', { name: 'GitHub Repo' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Repository').fill(REPO);
	await dialog.getByLabel('Branch').fill('main');
	await dialog.getByRole('button', { name: 'Add service' }).click();

	const panel = page.getByTestId('service-panel');
	await panel.getByRole('tab', { name: 'Variables' }).click();
	await page.getByLabel('New variable key').fill('BUILD_CANARY');
	await page.getByLabel('New variable value').fill('canary-e2e-5f4e3d2c');
	await page.getByRole('button', { name: 'Add', exact: true }).click();

	await panel.getByRole('tab', { name: 'Settings' }).click();
	await page.getByLabel('Port').fill('8080');
	await page.getByLabel('Port').press('Enter');
	await page.getByLabel('Healthcheck path').fill('/');
	await page.getByLabel('Healthcheck path').press('Enter');
	await page.getByRole('switch', { name: 'Public domain' }).click();
	await page.getByTestId('changes-bar').getByRole('button', { name: 'Deploy' }).click();

	const node = page.getByTestId('service-node').filter({ hasText: 'nodejs-getting-started' });
	await expect(node).toContainText('Building', { timeout: 60_000 });
	await expect(node).toContainText('Online', { timeout: 660_000 });

	const url = new URL(await page.getByTestId('service-url').innerText());
	const ingress = () => viaIngress(request, INGRESS_PORT, url.hostname);
	// Caddy reloads within a second or two, longer on a busy machine
	await expect.poll(async () => (await ingress()).status, { timeout: 60_000 }).toBe(200);
	expect((await ingress()).text).toContain('Node.js Getting Started');

	await panel.getByRole('tab', { name: 'Deployments' }).click();
	const deployments = page.getByTestId('deployments');
	await expect(deployments).toContainText(/· [0-9a-f]{7}/);
	const logs = page.getByTestId('deployment-logs');
	await expect(logs).toContainText('Building with Railpack');
	await expect(logs).toContainText('Build succeeded');
	await expect(logs).toContainText('Deployment is live');
	await expect(logs).not.toContainText('canary-e2e-5f4e3d2c');

	// a redeploy reuses the built image: no clone, no build
	await deployments.getByRole('button', { name: 'Redeploy' }).click();
	await expect(deployments.getByRole('listitem')).toHaveCount(2);
	await expect(logs).toContainText('Deployment is live', { timeout: 60_000 });
	await expect(logs).not.toContainText('Cloning');
	await expect(logs).toContainText('Redeploy of');
});
