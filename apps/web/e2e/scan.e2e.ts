import { createProject, expect, signUp, test } from './helpers';

test.skip(process.env.TRAMLINE_E2E_DOCKER !== '1', 'needs Docker: set TRAMLINE_E2E_DOCKER=1');
// the first scan downloads Trivy's vulnerability database
test.setTimeout(600_000);

test('block mode refuses an image with fixable critical vulnerabilities', async ({ page }) => {
	await signUp(page);
	await createProject(page, 'Scanning');
	await expect(page.getByTestId('node-status')).toContainText('1/1 node online', {
		timeout: 30_000
	});

	// Alpine 3.12.0 has long-fixed critical vulnerabilities (e.g. in openssl and musl)
	await page.keyboard.press('ControlOrMeta+k');
	await page.getByRole('option', { name: 'Docker Image' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Image').fill('alpine:3.12.0');
	await dialog.getByRole('button', { name: 'Add service' }).click();

	const panel = page.getByTestId('service-panel');
	await panel.getByRole('tab', { name: 'Settings' }).click();
	await page.getByRole('combobox', { name: 'Vulnerability scan' }).click();
	await page.getByRole('option', { name: 'Block fixable critical vulnerabilities' }).click();
	await expect(page.getByText('are refused before they run')).toBeVisible();
	await page.getByTestId('changes-bar').getByRole('button', { name: 'Deploy' }).click();

	await panel.getByRole('tab', { name: 'Deployments' }).click();
	await expect(page.getByTestId('deployment-message')).toContainText(
		/Blocked: \d+ critical vulnerabilit(y|ies) with a fix available/,
		{ timeout: 540_000 }
	);
	await expect(page.getByTestId('scan-summary')).toContainText('blocked');
	// the findings and the scan's own output are both there to act on
	await expect(page.getByTestId('scan-findings')).toContainText('critical');
	await expect(page.getByTestId('deployment-logs')).toContainText('fixed in');
	// it never ran
	await expect(page.getByTestId('service-node').filter({ hasText: 'alpine' })).not.toContainText(
		'Online'
	);
});
