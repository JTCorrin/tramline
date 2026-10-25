import { createProject, expect, signUp, test } from './helpers';

test.skip(process.env.TRAMLINE_E2E_DOCKER !== '1', 'needs Docker: set TRAMLINE_E2E_DOCKER=1');
test.setTimeout(300_000);

test('a cron service runs to completion, on demand and on its schedule', async ({ page }) => {
	await signUp(page);
	await createProject(page, 'Cron');
	await expect(page.getByTestId('node-status')).toContainText('1/1 node online', {
		timeout: 30_000
	});

	await page.keyboard.press('ControlOrMeta+k');
	await page.getByRole('option', { name: 'Docker Image' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Image').fill('busybox:1.37.0');
	await dialog.getByRole('button', { name: 'Add service' }).click();

	const panel = page.getByTestId('service-panel');
	await panel.getByRole('tab', { name: 'Settings' }).click();
	await page.getByLabel('Start command').fill('echo "report generated for $TRAMLINE_SERVICE_NAME"');
	await page.getByLabel('Start command').press('Enter');
	await page.getByLabel('Cron schedule').fill('* * * * *');
	await page.getByLabel('Cron schedule').press('Enter');
	// not what this test is about, and scans queue behind other tests' on a shared node
	await page.getByRole('combobox', { name: 'Vulnerability scan' }).click();
	await page.getByRole('option', { name: 'Off' }).click();
	await page.getByTestId('changes-bar').getByRole('button', { name: 'Deploy' }).click();

	// live with no long-running container
	await panel.getByRole('tab', { name: 'Deployments' }).click();
	const runs = page.getByTestId('cron-runs');
	await expect(runs).toContainText('Next run in', { timeout: 120_000 });

	await runs.getByRole('button', { name: 'Run now' }).click();
	await expect(runs).toContainText(/succeeded.*by hand.*exit code 0/, { timeout: 120_000 });
	await expect(page.getByTestId('deployment-logs')).toContainText('report generated for busybox');

	// and the schedule fires within a minute
	await expect(runs).toContainText(/succeeded.*scheduled/, { timeout: 120_000 });
});
