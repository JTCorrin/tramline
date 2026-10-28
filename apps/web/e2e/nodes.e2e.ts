import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { E2E_AGENT_IMAGE, E2E_NODE, INGRESS_PORT } from '../playwright.config';
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

// it claims the install and creates a second Docker daemon, so a retry can't start over
test.describe.configure({ retries: 0 });

let agent: ChildProcess | undefined;
let agentLog = '';

/** What each node's mesh saw, attached when the test fails. */
// Playwright requires the fixtures argument to be destructured, even when none are used
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
	if (testInfo.status === testInfo.expectedStatus) return;
	const run = (cmd: string) => {
		try {
			return execFileSync('sh', ['-c', `${cmd} 2>&1`], { encoding: 'utf8' });
		} catch (error) {
			return String((error as { stdout?: string }).stdout ?? error);
		}
	};
	const local = '$(docker ps -q --filter name=tramline-mesh- | head -1)';
	const remote = `docker -H ${dockerHost}`;
	const remoteMesh = `$(${remote} ps -q --filter name=tramline-mesh- | head -1)`;
	const report = [
		'== local mesh logs',
		run(`docker logs ${local}`),
		'== local wg show',
		run(`docker exec ${local} wg show`),
		'== local mesh config (without its key)',
		run(`docker exec ${local} grep -v privateKey /etc/tramline/mesh.json`),
		'== second node: containers',
		run(`${remote} ps -a --format '{{.Names}} {{.Status}}'`),
		'== second node: mesh logs',
		run(`${remote} logs ${remoteMesh}`),
		'== second node: wg show',
		run(`${remote} exec ${remoteMesh} wg show`),
		'== local mesh: addresses, routes, listeners',
		run(`docker exec ${local} sh -c "ip -br addr; ip route; ss -ltn"`),
		'== local mesh: connecting to each remote forward',
		run(
			`docker exec ${local} node -e "const net=require('net');const c=JSON.parse(require('fs').readFileSync('/etc/tramline/mesh.json','utf8'));for(const f of c.forwards.filter(f=>f.to==='remote')){const s=net.connect(f.port,f.address);s.setTimeout(3000);s.on('connect',()=>{console.log(f.address+':'+f.port,'connected');s.destroy()});s.on('timeout',()=>{console.log(f.address+':'+f.port,'timed out');s.destroy()});s.on('error',e=>console.log(f.address+':'+f.port,e.message))}"`
		),
		'== second node mesh: addresses, routes, listeners',
		run(`${remote} exec ${remoteMesh} sh -c "ip -br addr; ip route; ss -ltn"`),
		'== second node: agent',
		agentLog
	].join('\n');
	await testInfo.attach('mesh-diagnostics', { body: report, contentType: 'text/plain' });
	console.log(report);
});

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

test('enroll a second node, reach it over the mesh, then move off it and remove it', async ({
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

	// it runs its mesh container from this checkout's agent image
	execFileSync('sh', ['-c', `docker save ${E2E_AGENT_IMAGE} | docker -H ${dockerHost} load -q`], {
		stdio: 'ignore'
	});

	// an install admin creates a join command, starting the node cordoned
	// whoever has the setup token from the server's data directory claims the install
	await signUp(page, 'Nodes Org');
	await page.goto('/nodes');
	const setupToken = readFileSync(
		path.resolve(import.meta.dirname, '../data/e2e/setup-token'),
		'utf8'
	);
	await page.getByLabel('Setup token').fill(setupToken.trim());
	await page.getByRole('button', { name: 'Claim' }).click();
	await expect(page.getByTestId('install-admins')).toBeVisible();
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
			TRAMLINE_AGENT_HEALTH_PORT: String(E2E_NODE.healthPort),
			TRAMLINE_MESH_IMAGE: E2E_AGENT_IMAGE
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

	// neither node has a public address yet, so the mesh can't connect them
	await page.goto('/nodes');
	await expect(row.getByTestId('node-mesh')).toContainText('behind NAT');
	await expect(row).toContainText("Can't reach local");

	// give the second node an address the first can reach: here, on the first node's mesh network
	const nodes = (await (await page.request.get('/api/v1/nodes')).json()) as {
		id: string;
		name: string;
	}[];
	const local = nodes.find((n) => n.name === 'local')!;
	await expect
		.poll(
			() => {
				try {
					execFileSync('docker', ['network', 'inspect', `tl-mesh-${local.id}`], {
						stdio: 'ignore'
					});
					return true;
				} catch {
					return false;
				}
			},
			{ timeout: 60_000 }
		)
		.toBe(true);
	execFileSync('docker', ['network', 'connect', `tl-mesh-${local.id}`, E2E_NODE.container]);
	const ip = execFileSync(
		'docker',
		[
			'inspect',
			'-f',
			`{{(index .NetworkSettings.Networks "tl-mesh-${local.id}").IPAddress}}`,
			E2E_NODE.container
		],
		{ encoding: 'utf8' }
	).trim();
	await row.getByLabel('Mesh endpoint').fill(`${ip}:51820`);
	await row.getByRole('button', { name: 'Save' }).click();
	await expect(row.getByTestId('node-mesh')).toContainText(`reachable at ${ip}:51820`);
	await expect(row).not.toContainText("Can't reach");

	// the local node is an edge, so it serves the service's domain too, over the mesh
	const onLocal = () => viaIngress(request, INGRESS_PORT, url.hostname);
	await expect.poll(async () => (await onLocal()).status, { timeout: 120_000 }).toBe(200);
	expect((await onLocal()).text).toContain('Hostname:');

	// and a service on the local node reaches it by its private name
	await page.goBack();
	// History navigation can finish before the project has hydrated. Opening
	// via Add is idempotent, so retry until its handler opens the palette.
	await expect(async () => {
		await page.getByRole('button', { name: /^Add/ }).click({ timeout: 1_000 });
		await expect(page.getByRole('option', { name: 'Docker Image' })).toBeVisible({
			timeout: 1_000
		});
	}).toPass({ timeout: 15_000 });
	await page.getByRole('option', { name: 'Docker Image' }).click();
	await dialog.getByLabel('Image').fill('busybox:1.37');
	await dialog.getByRole('button', { name: 'Add service' }).click();
	await panel.getByRole('tab', { name: 'Settings' }).click();
	await page.getByLabel('Vulnerability scan').click();
	await page.getByRole('option', { name: 'Off' }).click();
	await page
		.getByLabel('Start command')
		.fill(
			'until wget -qO- http://whoami.production.tramline.internal/; do sleep 2; done; sleep 3600'
		);
	await page.getByLabel('Start command').press('Enter');
	await page.getByLabel('Run on').click();
	await page.getByRole('option', { name: 'local', exact: true }).click();
	await page.getByTestId('changes-bar').getByRole('button', { name: 'Deploy' }).click();
	await panel.getByRole('tab', { name: 'Deployments' }).click();
	await expect(page.getByTestId('deployment-logs')).toContainText('Hostname:', {
		timeout: 180_000
	});

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
	// served from the local node's own container now, and no longer by the second node
	await expect.poll(async () => (await onNode2()).status, { timeout: 300_000 }).toBe(404);
	await expect.poll(async () => (await onLocal()).status, { timeout: 30_000 }).toBe(200);

	// an empty node can be removed, and its agent is shut out
	await page.goto('/nodes');
	await expect(row).toContainText('0 deployments', { timeout: 30_000 });
	page.once('dialog', (d) => d.accept());
	await row.getByRole('button', { name: 'Remove' }).click();
	await expect(row).toHaveCount(0);
	await expect.poll(() => agentLog, { timeout: 30_000 }).toContain('no longer knows this node');
	// alone again, the local node leaves the mesh
	await expect
		.poll(() =>
			execFileSync('docker', ['ps', '-q', '--filter', `name=tramline-mesh-${local.id}`], {
				encoding: 'utf8'
			}).trim()
		)
		.toBe('');
});
