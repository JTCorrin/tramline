import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { E2E_NODE, INGRESS_PORT, NODES_ADMIN } from '../playwright.config';
import { createProject, expect, signUp, test, viaIngress } from './helpers';

test.skip(process.env.TRAMLINE_E2E_DOCKER !== '1', 'needs Docker: set TRAMLINE_E2E_DOCKER=1');
// a fresh Docker daemon pulls Caddy and the workload's image
test.setTimeout(600_000);

const dockerHost = `tcp://127.0.0.1:${E2E_NODE.dockerPort}`;
const inNode = (...args: string[]) =>
	execFileSync('docker', ['-H', dockerHost, ...args], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore']
	}).trim();

let agent: ChildProcess | undefined;
let agentLog = '';

test.afterAll(() => {
	if (agent?.pid) {
		try {
			process.kill(-agent.pid, 'SIGTERM');
		} catch {
			// already gone
		}
	}
	execFileSync('docker', ['rm', '-f', '-v', E2E_NODE.container], { stdio: 'ignore' });
});

test('enroll a second node, pin a service to it, then move it off and remove the node', async ({
	page,
	request
}) => {
	// the second machine: its own Docker daemon, reachable only from this one
	execFileSync('docker', ['rm', '-f', '-v', E2E_NODE.container], { stdio: 'ignore' });
	execFileSync('docker', [
		'run',
		'-d',
		'--privileged',
		'--name',
		E2E_NODE.container,
		'-e',
		'DOCKER_TLS_CERTDIR=',
		'-p',
		`127.0.0.1:${E2E_NODE.dockerPort}:2375`,
		'-p',
		`127.0.0.1:${E2E_NODE.ingressPort}:${INGRESS_PORT}`,
		'docker:27-dind'
	]);
	await expect
		.poll(
			() => {
				try {
					return inNode('version', '--format', '{{.Server.Version}}');
				} catch {
					return '';
				}
			},
			{ timeout: 60_000 }
		)
		.not.toBe('');

	// an install admin creates a join command, starting the node cordoned
	await signUp(page, 'Nodes Org', NODES_ADMIN);
	await page.goto('/nodes');
	const add = page.getByTestId('add-node');
	await add.getByLabel('Name').fill('dind');
	await add.getByRole('switch', { name: 'Start cordoned' }).click();
	await add.getByRole('button', { name: 'Create join command' }).click();
	const command = await page.getByTestId('join-command').inputValue();
	expect(command).toContain('/install.sh | sudo sh -s -- --url http://localhost:4173 --token ');
	const token = command.split('--token ')[1]!;

	// the agent joins with it (on this machine, driving the second daemon)
	agent = spawn('pnpm', ['--filter', '@tramline/agent', 'start'], {
		cwd: path.resolve(import.meta.dirname, '..'),
		detached: true,
		env: {
			...process.env,
			TRAMLINE_URL: 'http://localhost:4173',
			TRAMLINE_JOIN_TOKEN: token,
			DOCKER_HOST: dockerHost,
			TRAMLINE_AGENT_STATE_DIR: mkdtempSync(path.join(tmpdir(), 'tramline-e2e-node2-')),
			TRAMLINE_AGENT_HEALTH_PORT: String(E2E_NODE.healthPort)
		}
	});
	agent.stdout?.on('data', (chunk) => (agentLog += chunk));
	agent.stderr?.on('data', (chunk) => (agentLog += chunk));

	const row = page.locator('[data-testid="node-row"][data-node="dind"]');
	await expect(row).toContainText('online', { timeout: 60_000 });
	await expect(row).toContainText('Cordoned');
	expect(agentLog).toContain('joined as node dind');

	// a service pinned to the cordoned node still runs there
	await page.goto('/');
	await createProject(page, 'Two nodes');
	await expect(page.getByTestId('node-status')).toContainText('2/2 nodes online');
	await page.keyboard.press('ControlOrMeta+k');
	await page.getByRole('option', { name: 'Docker Image' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Image').fill('traefik/whoami');
	await dialog.getByRole('button', { name: 'Add service' }).click();

	const panel = page.getByTestId('service-panel');
	await panel.getByRole('tab', { name: 'Settings' }).click();
	await page.getByLabel('Port').fill('80');
	await page.getByLabel('Port').press('Enter');
	await page.getByRole('switch', { name: 'Public domain' }).click();
	await page.getByLabel('Vulnerability scan').click();
	await page.getByRole('option', { name: 'Off' }).click();
	await page.getByLabel('Run on').click();
	await page.getByRole('option', { name: 'dind (cordoned)' }).click();
	await page.getByTestId('changes-bar').getByRole('button', { name: 'Deploy' }).click();

	const node = page.getByTestId('service-node').filter({ hasText: 'whoami' });
	await expect(node).toContainText('Online', { timeout: 300_000 });
	const url = new URL(await page.getByTestId('service-url').innerText());
	// served by the second node's own ingress, from a container in its daemon
	const onNode2 = () => viaIngress(request, E2E_NODE.ingressPort, url.hostname);
	await expect.poll(async () => (await onNode2()).status, { timeout: 30_000 }).toBe(200);
	expect(
		inNode('ps', '--filter', 'label=tramline.role=workload', '--format', '{{.Image}}')
	).toContain('whoami');

	// draining keeps a pinned service where it is
	await page.goto('/nodes');
	await expect(row).toContainText('1 deployment');
	await row.getByRole('button', { name: 'Drain' }).click();
	await expect(page.getByText('Staying: whoami')).toBeVisible();
	await expect(row).toContainText('Draining');

	// unpinned, it can't go back to a cordoned node, so it moves to the local one
	await page.goBack();
	await page.getByTestId('service-node').filter({ hasText: 'whoami' }).click();
	await panel.getByRole('tab', { name: 'Settings' }).click();
	await page.getByLabel('Run on').click();
	await page.getByRole('option', { name: 'Any node' }).click();
	await page.getByTestId('changes-bar').getByRole('button', { name: 'Deploy' }).click();
	const onLocal = () => viaIngress(request, INGRESS_PORT, url.hostname);
	await expect.poll(async () => (await onLocal()).status, { timeout: 300_000 }).toBe(200);
	await expect.poll(async () => (await onNode2()).status, { timeout: 60_000 }).toBe(404);

	// an empty node can be removed, and its agent is shut out
	await page.goto('/nodes');
	await expect(row).toContainText('0 deployments', { timeout: 30_000 });
	page.once('dialog', (d) => d.accept());
	await row.getByRole('button', { name: 'Remove' }).click();
	await expect(row).toHaveCount(0);
	await expect.poll(() => agentLog, { timeout: 30_000 }).toContain('no longer knows this node');
});
