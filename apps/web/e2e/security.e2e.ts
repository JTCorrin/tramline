import type { Page } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { expect, test } from './helpers';

const PASSWORD = 'e2e-password-1234';

/** RFC 6238 TOTP, as an authenticator app computes it. */
function totp(secret: string, at = Date.now(), offset = 0) {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = '';
	for (const c of secret.replace(/=+$/, '').toUpperCase()) {
		bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
	}
	const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000) + offset));
	const mac = createHmac('sha1', key).update(counter).digest();
	const at4 = mac[mac.length - 1]! & 0xf;
	return String((mac.readUInt32BE(at4) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function signUp(page: Page) {
	const email = `e2e-${crypto.randomUUID()}@tramline.test`;
	await page.goto('/sign-up');
	await page.getByLabel('Name').fill('Security Tester');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Create account' }).click();
	await page.getByLabel('Organization name').fill('Security Org');
	await page.getByRole('button', { name: 'Create organization' }).click();
	await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
	return email;
}

async function signOut(page: Page) {
	await page.getByRole('button', { name: 'Account menu' }).click();
	await page.getByRole('menuitem', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/sign-in$/);
}

test('two-factor authentication: enrol, then sign in with a code or a backup code', async ({
	page
}) => {
	const email = await signUp(page);
	await page.goto('/settings');
	const card = page.getByTestId('two-factor');
	await card.getByLabel('Your password').fill(PASSWORD);
	await card.getByRole('button', { name: 'Turn on' }).click();
	await expect(card.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
	const secret = (await card.getByTestId('totp-secret').innerText()).trim();

	await card.getByLabel('Code from your app').fill('000000');
	await card.getByRole('button', { name: 'Confirm' }).click();
	await expect(card).toContainText(/invalid|not right/i);
	await card.getByLabel('Code from your app').fill(totp(secret));
	await card.getByRole('button', { name: 'Confirm' }).click();
	const backupCodes = (await card.getByTestId('backup-codes').innerText()).trim().split('\n');
	expect(backupCodes.length).toBeGreaterThan(5);
	await card.getByRole('button', { name: 'I’ve saved them' }).click();
	await expect(card).toContainText('on');

	// a password alone is no longer enough
	await signOut(page);
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page).toHaveURL(/\/two-factor$/);
	const dashboard = page.getByRole('heading', { name: 'Projects', exact: true });
	const rejected = page.getByText(/invalid|not right/i);
	await page.getByLabel('Code').fill(totp(secret));
	await page.getByRole('button', { name: 'Verify' }).click();
	// a code that was already used to enrol can be refused; the app's next code then works
	await expect(dashboard.or(rejected)).toBeVisible();
	if (await rejected.isVisible()) {
		await expect
			.poll(() => totp(secret), { timeout: 35_000, intervals: [1000] })
			.not.toBe(await page.getByLabel('Code').inputValue());
		await page.getByLabel('Code').fill(totp(secret));
		await page.getByRole('button', { name: 'Verify' }).click();
	}
	await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();

	// and a backup code works once
	await signOut(page);
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await page.getByRole('button', { name: 'Use a backup code' }).click();
	await page.getByLabel('Backup code').fill(backupCodes[0]!);
	await page.getByRole('button', { name: 'Verify' }).click();
	await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
});

test('passkeys: add one, then sign in with it alone', async ({ page, browserName }) => {
	test.skip(browserName !== 'chromium', 'the virtual authenticator is a Chromium feature');
	// a platform authenticator that always verifies the user, like Touch ID would
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});

	await signUp(page);
	await page.goto('/settings');
	const passkeys = page.getByTestId('passkeys');
	await passkeys.getByLabel('Passkey name').fill('Test laptop');
	await passkeys.getByRole('button', { name: 'Add a passkey' }).click();
	await expect(passkeys).toContainText('Test laptop');

	await signOut(page);
	await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
	await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
});

test('GitHub Actions: trust a repository, and the exchange refuses anything but GitHub’s tokens', async ({
	page,
	request
}) => {
	await signUp(page);
	await page.goto('/settings');
	const card = page.getByTestId('github-actions');
	await card.getByLabel('Repository').fill('Acme/API');
	await card.getByRole('button', { name: 'Trust repository' }).click();
	await expect(card.getByTestId('trust-rules')).toContainText('acme/api · refs/heads/main');
	await expect(card.getByTestId('trust-rules')).toContainText('deploy · never used');
	await card.getByText('Example workflow step').click();
	await expect(card).toContainText('audience=http://localhost:4173');

	const forged = await request.post('/api/v1/oidc/github', {
		data: { token: 'eyJhbGciOiJub25lIn0.eyJyZXBvc2l0b3J5IjoiYWNtZS9hcGkifQ.' }
	});
	expect(forged.status()).toBe(401);
	expect((await forged.json()).error.message).toBe('Unsupported token signature');
	const empty = await request.post('/api/v1/oidc/github', { data: {} });
	expect(empty.status()).toBe(400);
});
