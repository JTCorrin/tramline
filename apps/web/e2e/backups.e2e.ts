import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { controlPlaneBackupEnv, E2E_S3 } from '../playwright.config';
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
	// a fresh database initialises before it accepts connections
	await expect
		.poll(
			() => {
				try {
					return psql('select 1');
				} catch {
					return 'not ready';
				}
			},
			{ timeout: 60_000 }
		)
		.toBe('1');
	psql("create table notes (body text); insert into notes values ('before the backup')");

	// the read-only Data tab shows what's in the database
	await page.getByTestId('service-panel').getByRole('tab', { name: 'Data' }).click();
	await page.getByTestId('data-tables').getByRole('button', { name: /notes/ }).click();
	await expect(page.getByTestId('data-rows')).toContainText('before the backup');

	await backUpAndRestore(page, () =>
		psql(
			"insert into notes values ('after the backup'); delete from notes where body like 'before%'"
		)
	);
	expect(psql('select body from notes')).toBe('before the backup');

	// a restore drill loads the backup into a throwaway Postgres
	await page.getByTestId('backup-list').getByRole('button', { name: 'Verify' }).click();
	await expect(page.getByTestId('drill-status')).toContainText(
		/Verified .*: Loaded 1 database with 1 table into a scratch Postgres/,
		{ timeout: 180_000 }
	);

	// what reached the bucket is encrypted
	// the install's own snapshots share the bucket, so look for this service's dump
	const object = bucketObjects().find((key) => key.endsWith('.sql.gz.enc'));
	expect(object).toBeDefined();
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

	// a restore drill reads the whole archive back
	await page.getByTestId('backup-list').getByRole('button', { name: 'Verify' }).click();
	await expect(page.getByTestId('drill-status')).toContainText(
		/Verified .*: An archive of \d+ files?/,
		{
			timeout: 120_000
		}
	);
});

test('snapshots this install’s database, drills it, and the restore command reads it', async ({
	page
}) => {
	await signUp(page, 'Install Org');
	await page.goto('/settings');
	const status = page.getByTestId('control-plane-backups');
	// the scheduler's first pass is a minute after start
	await expect(status).toContainText('Last snapshot', { timeout: 150_000 });
	await expect(status).toContainText('Restore drill passed', { timeout: 60_000 });

	const [snapshot] = bucketObjects().filter((key) =>
		key.includes('/install/tramline/control-plane/')
	);
	expect(snapshot).toMatch(/\.sqlite\.gz\.enc$/);
	expect(magic(snapshot!)).toBe('TLB1');

	// the restore command, as an operator would run it (--check only: the test install keeps running)
	const output = execFileSync('pnpm', ['restore-control-plane', '--check'], {
		cwd: path.resolve(import.meta.dirname, '..'),
		encoding: 'utf8',
		env: {
			...process.env,
			...controlPlaneBackupEnv(),
			TRAMLINE_SECRET_KEY: 'e2e-only-secret-key-not-for-production-use'
		}
	});
	expect(output).toContain("decrypts and passes SQLite's integrity check");
	expect(output).toMatch(/[1-9]\d* organizations/);
});
