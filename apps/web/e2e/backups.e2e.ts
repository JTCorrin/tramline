import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { E2E_S3 } from '../playwright.config';
import { createProject, currentEnvironment, execIn, expect, signUp, test } from './helpers';

test.skip(process.env.TRAMLINE_E2E_DOCKER !== '1', 'needs Docker: set TRAMLINE_E2E_DOCKER=1');
// images to pull and scan, and a database to start, back up and restore
test.setTimeout(600_000);

const node = (page: Page, text: string) =>
	page.getByTestId('service-node').filter({ hasText: text });

async function setUpStorage(page: Page) {
	await page.goto('/settings');
	const card = page.getByTestId('backup-storage');
	await card.getByLabel('Endpoint').fill(`http://localhost:${E2E_S3.port}`);
	await card.getByLabel('Bucket').fill(E2E_S3.bucket);
	await card.getByLabel('Access key ID').fill(E2E_S3.accessKeyId);
	await card.getByLabel('Secret access key').fill(E2E_S3.secretAccessKey);
	await card.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('Backup storage saved')).toBeVisible();
	// the secret is never sent back
	await expect(card.getByLabel('Secret access key')).toHaveValue('');
	await card.getByRole('button', { name: 'Test connection' }).click();
	await expect(page.getByText('Connected: Tramline can write to the bucket')).toBeVisible();
	await page.goto('/');
}

/** The encrypted objects in the bucket, read straight from the gateway's directory. */
function bucketObjects() {
	return execFileSync(
		'docker',
		['exec', E2E_S3.container, 'sh', '-c', `find /tmp/s3/${E2E_S3.bucket} -type f -name '*.enc'`],
		{ encoding: 'utf8' }
	)
		.trim()
		.split('\n')
		.filter(Boolean);
}

const magic = (file: string) =>
	execFileSync('docker', ['exec', E2E_S3.container, 'head', '-c', '4', file], { encoding: 'utf8' });

async function backUpAndRestore(page: Page, change: () => void) {
	const panel = page.getByTestId('service-panel');
	await panel.getByRole('tab', { name: 'Backups' }).click();
	await page.getByRole('button', { name: 'Back up now' }).click();
	const list = page.getByTestId('backup-list');
	await expect(list).toContainText('succeeded', { timeout: 120_000 });

	change();

	await list.getByRole('button', { name: 'Restore' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Restore' }).click();
	await expect(page.getByTestId('restore-status')).toContainText('Restore succeeded', {
		timeout: 120_000
	});
}

test('back up Postgres to the bucket, encrypted, and restore it', async ({ page }) => {
	await signUp(page);
	await setUpStorage(page);
	await createProject(page, 'Backups');
	await expect(page.getByTestId('node-status')).toContainText('1/1 node online', {
		timeout: 30_000
	});

	await page.locator('.svelte-flow__pane').click({ button: 'right', position: { x: 200, y: 200 } });
	await page.getByRole('menuitem', { name: 'Database' }).hover();
	await page.getByRole('menuitem', { name: 'PostgreSQL' }).click();
	await page.getByTestId('changes-bar').getByRole('button', { name: 'Deploy' }).click();
	await expect(node(page, 'postgres:17')).toContainText('Online', { timeout: 540_000 });

	const env = await currentEnvironment(page);
	const psql = (sql: string) => execIn(env, 'postgres:17', `psql -U postgres -d app -tAc "${sql}"`);
	await expect
		.poll(() => {
			try {
				return psql('select 1');
			} catch {
				return 'not ready';
			}
		})
		.toBe('1');
	psql("create table notes (body text); insert into notes values ('before the backup')");

	await backUpAndRestore(page, () =>
		psql(
			"insert into notes values ('after the backup'); delete from notes where body like 'before%'"
		)
	);
	expect(psql('select body from notes')).toBe('before the backup');

	// what reached the bucket is encrypted
	const [object] = bucketObjects();
	expect(object).toMatch(/\.sql\.gz\.enc$/);
	expect(magic(object!)).toBe('TLB1');
});

test('back up a plain volume and restore it while the service is stopped', async ({ page }) => {
	await signUp(page, 'Volumes Org');
	await setUpStorage(page);
	await createProject(page, 'Volumes');
	await expect(page.getByTestId('node-status')).toContainText('1/1 node online', {
		timeout: 30_000
	});

	// a plain image (not the Redis template) with a volume: archived, not dumped
	await page.keyboard.press('ControlOrMeta+k');
	await page.getByRole('option', { name: 'Docker Image' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Image').fill('redis:7');
	await dialog.getByRole('button', { name: 'Add service' }).click();
	const panel = page.getByTestId('service-panel');
	await panel.getByRole('tab', { name: 'Settings' }).click();
	await page.getByLabel('Mount path').fill('/data');
	await page.getByLabel('Mount path').press('Enter');
	await page.getByTestId('changes-bar').getByRole('button', { name: 'Deploy' }).click();
	await expect(node(page, 'redis:7')).toContainText('Online', { timeout: 540_000 });

	const env = await currentEnvironment(page);
	const redis = (command: string) => execIn(env, 'redis:7', `redis-cli ${command}`);
	redis('set greeting before');
	redis('save');

	await backUpAndRestore(page, () => {
		redis('set greeting after');
		redis('save');
	});
	// the container was replaced; wait for the new one
	await expect(node(page, 'redis:7')).toContainText('Online', { timeout: 120_000 });
	await expect
		.poll(() => {
			try {
				return redis('get greeting');
			} catch {
				return 'not ready';
			}
		})
		.toBe('before');
});
