import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { createSecrets } from '../src/lib/server/crypto';
import { createProject, expect, signUp, test } from './helpers';

// must match playwright.config.ts
const secrets = createSecrets('e2e-only-secret-key-not-for-production-use');
const WEBHOOK_SECRET = 'e2e-webhook-secret';
const REPO = 'https://github.com/tramline-e2e/push-test';
const COMMIT = 'c0ffee'.padEnd(40, '0');

/** Stands in for creating the app on GitHub: writes its row like the manifest flow would. */
function seedGitHubApp() {
	const db = new Database(path.resolve(import.meta.dirname, '../data/e2e.db'));
	db.prepare(
		`insert or replace into github_app (id, slug, name, html_url, owner, client_id, client_secret, private_key, webhook_secret)
		 values ('1', 'tramline-e2e', 'Tramline e2e', 'https://github.com/apps/tramline-e2e', 'e2e', 'Iv1', ?, ?, ?)`
	).run(secrets.encrypt('x'), secrets.encrypt('not-a-real-key'), secrets.encrypt(WEBHOOK_SECRET));
	db.close();
}

test('create the GitHub App by posting its manifest to GitHub', async ({ page }) => {
	await signUp(page);
	await page.getByRole('button', { name: 'Account menu' }).click();
	await page.getByRole('menuitem', { name: 'Settings' }).click();
	const card = page.getByTestId('github-settings');
	await expect(card).toContainText('read-only access');

	// intercept the real form post to github.com and inspect what would be sent
	let posted: { url: string; manifest: Record<string, unknown> } | null = null;
	await page.route('https://github.com/**', async (route) => {
		const params = new URLSearchParams(route.request().postData() ?? '');
		posted = { url: route.request().url(), manifest: JSON.parse(params.get('manifest')!) };
		await route.fulfill({ body: '<h1>GitHub</h1>', contentType: 'text/html' });
	});
	await card.getByLabel('GitHub organization (optional)').fill('acme-inc');
	await card.getByRole('button', { name: 'Create GitHub App' }).click();
	await expect(page.locator('h1')).toHaveText('GitHub');

	expect(posted!.url).toMatch(
		/^https:\/\/github\.com\/organizations\/acme-inc\/settings\/apps\/new\?state=[\w-]+$/
	);
	expect(posted!.manifest).toMatchObject({
		redirect_url: 'http://localhost:4173/api/github/manifest',
		setup_url: 'http://localhost:4173/api/github/setup',
		public: false,
		default_permissions: { contents: 'read', metadata: 'read' },
		// localhost can't receive webhooks, so none are requested and Tramline polls instead
		default_events: []
	});
});

test('a signed push deploys the new commit', async ({ page, request }) => {
	await signUp(page);
	await createProject(page, 'Pushy');

	await page.keyboard.press('ControlOrMeta+k');
	await page.getByRole('option', { name: 'GitHub Repo' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Repository').fill(REPO);
	await dialog.getByLabel('Branch').fill('main');
	await dialog.getByRole('button', { name: 'Add service' }).click();

	const panel = page.getByTestId('service-panel');
	await panel.getByRole('tab', { name: 'Settings' }).click();
	await expect(page.getByRole('switch', { name: 'Deploy on push' })).toBeChecked();
	await page.getByTestId('changes-bar').getByRole('button', { name: 'Deploy' }).click();
	await expect(page.getByTestId('changes-bar')).toBeHidden();

	seedGitHubApp();
	const body = JSON.stringify({
		ref: 'refs/heads/main',
		after: COMMIT,
		repository: { full_name: 'tramline-e2e/push-test' },
		commits: [{ modified: ['index.js'] }],
		pusher: { name: 'octocat' }
	});
	const sign = (secret: string) =>
		`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

	const forged = await request.post('/api/github/webhook', {
		data: body,
		headers: {
			'content-type': 'application/json',
			'x-github-event': 'push',
			'x-hub-signature-256': sign('wrong')
		}
	});
	expect(forged.status()).toBe(401);

	const delivery = await request.post('/api/github/webhook', {
		data: body,
		headers: {
			'content-type': 'application/json',
			'x-github-event': 'push',
			'x-hub-signature-256': sign(WEBHOOK_SECRET)
		}
	});
	expect(delivery.status()).toBe(202);
	expect((await delivery.json()).deployments).toHaveLength(1);

	await panel.getByRole('tab', { name: 'Deployments' }).click();
	const deployments = page.getByTestId('deployments');
	await expect(deployments.getByRole('listitem')).toHaveCount(2);
	await expect(deployments).toContainText(`· ${COMMIT.slice(0, 7)}`);
	await expect(page.getByTestId('deployment-logs')).toContainText(
		`Push of ${COMMIT.slice(0, 7)} to main by octocat`
	);
});
