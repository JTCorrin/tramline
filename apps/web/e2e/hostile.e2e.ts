import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { INGRESS_PORT } from '../playwright.config';
import {
	ALL_NODES_ONLINE,
	createProject,
	currentEnvironment,
	execIn,
	expect,
	signUp,
	test
} from './helpers';

/**
 * A pen test in CI: a workload runs the steps a hostile tenant was seen
 * taking on another platform (hunting for credentials, the cloud metadata
 * endpoint, the platform's and Docker's APIs, guessing another project's
 * private names, scanning the private ranges) and each must get nothing and
 * show on its service as a security event, with an alert. A scanner reaching
 * another service from outside shows on that service's Traffic tab with its
 * network's name, and alerts too.
 */

test.skip(process.env.TRAMLINE_E2E_DOCKER !== '1', 'needs Docker: set TRAMLINE_E2E_DOCKER=1');
test.setTimeout(600_000);

const ATTACKER = 'busybox:1.37';
const VICTIM = 'traefik/whoami';
/** What Tramline tells a workload about itself; none of it opens anything. */
const DESCRIBING = [
	'TRAMLINE_ENVIRONMENT_ID',
	'TRAMLINE_ENVIRONMENT_NAME',
	'TRAMLINE_PRIVATE_DOMAIN',
	'TRAMLINE_PUBLIC_DOMAIN',
	'TRAMLINE_SERVICE_ID',
	'TRAMLINE_SERVICE_NAME',
	'TRAMLINE_VOLUME_MOUNT_PATH'
];
/** Node, join and API tokens. */
const TOKEN = /\b(tlnode_|tljoin_|tl_)[A-Za-z0-9_-]{20,}/;

async function addService(
	page: Page,
	projectId: string,
	environmentId: string,
	image: string,
	patch: object
) {
	const created = await page.request.post('/api/v1/services', {
		data: { projectId, kind: 'image', source: { type: 'image', image } }
	});
	expect(created.ok(), await created.text()).toBe(true);
	const service = (await created.json()) as { id: string };
	const staged = await page.request.patch(
		`/api/v1/services/${service.id}/config?environmentId=${environmentId}`,
		{ data: { build: { scan: 'off' }, ...patch } }
	);
	expect(staged.ok(), await staged.text()).toBe(true);
	const deployed = await page.request.post(`/api/v1/environments/${environmentId}/deploy`, {
		data: {}
	});
	expect(deployed.ok(), await deployed.text()).toBe(true);
	return service.id;
}

/** Waits for a service to be online, and returns its public URL (if it has one). */
async function online(page: Page, environmentId: string, serviceId: string) {
	let url: string | null = null;
	await expect
		.poll(
			async () => {
				const canvas = (await (
					await page.request.get(`/api/v1/environments/${environmentId}/canvas`)
				).json()) as { services: { id: string; status: string; url: string | null }[] };
				const service = canvas.services.find((s) => s.id === serviceId);
				url = service?.url ?? null;
				return service?.status;
			},
			{ timeout: 540_000, intervals: [2_000] }
		)
		.toBe('active');
	return url;
}

/** The address of a running container of `image` in an environment, as Docker's network gives it. */
function containerIp(environmentId: string, image: string) {
	const name = execFileSync(
		'docker',
		[
			'ps',
			'--filter',
			'label=tramline.role=workload',
			'--filter',
			`ancestor=${image}`,
			'--filter',
			`network=tl-${environmentId}`,
			'--format',
			'{{.Names}}'
		],
		{ encoding: 'utf8' }
	).trim();
	return execFileSync(
		'docker',
		[
			'inspect',
			'-f',
			`{{(index .NetworkSettings.Networks "tl-${environmentId}").IPAddress}}`,
			name
		],
		{ encoding: 'utf8' }
	).trim();
}

test('a hostile tenant gets nothing, and its owner sees every step', async ({ page }) => {
	await signUp(page);
	const nodes = async () =>
		(await (await page.request.get('/api/v1/nodes')).json()) as {
			id: string;
			name: string;
			containment: { state: string } | null;
		}[];

	// someone else's project on the same node: a public service with a private name
	await createProject(page, 'Victim');
	await expect(page.getByTestId('node-status')).toHaveText(ALL_NODES_ONLINE, { timeout: 30_000 });
	const local = (await nodes()).find((n) => n.name === 'local')!.id;
	const victimEnv = await currentEnvironment(page);
	const victimProject = new URL(page.url()).pathname.split('/').at(-1)!;
	const victim = await addService(page, victimProject, victimEnv, VICTIM, {
		networking: { port: 80, publicDomain: true },
		deploy: { node: local }
	});

	await page.goto('/');
	await createProject(page, 'Attacker');
	const env = await currentEnvironment(page);
	const projectId = new URL(page.url()).pathname.split('/').at(-1)!;
	const attacker = await addService(page, projectId, env, ATTACKER, {
		deploy: { startCommand: 'sleep 3600', node: local }
	});
	const victimUrl = await online(page, victimEnv, victim);
	await online(page, env, attacker);
	expect(victimUrl).not.toBeNull();
	await expect
		.poll(async () => (await nodes()).find((n) => n.id === local)?.containment?.state, {
			timeout: 60_000
		})
		.toBe('active');

	const run = (command: string) => execIn(env, ATTACKER, `${command} 2>&1; true`);
	/** What a wget got: an HTTP status line, or only an error. */
	const fetchFrom = (url: string) => run(`wget -T 3 -S -O /dev/null '${url}'`);

	// each step is checked softly, so one run reports every step that got through
	// 1. credentials in its environment and files: none of the platform's
	// only the variables that describe the service itself, and nothing shaped like a token
	const variables = run('env');
	const names = [...variables.matchAll(/^(TRAMLINE_[A-Z_]+)=/gm)].map((m) => m[1]);
	for (const name of names) expect.soft(DESCRIBING).toContain(name);
	expect.soft(variables).not.toMatch(TOKEN);
	expect
		.soft(
			run(
				'for f in /var/run/docker.sock /run/docker.sock /var/lib/tramline /etc/tramline; do [ -e $f ] && echo found $f; done; grep docker.sock /proc/self/mountinfo'
			)
		)
		.toBe('');
	expect.soft(run("grep -rlsE 'tlnode_|tljoin_' /etc /root /home /tmp /var /run /opt")).toBe('');

	// 2. the cloud metadata endpoints (on a cloud node they would answer)
	expect.soft(fetchFrom('http://169.254.169.254/computeMetadata/v1/')).not.toContain('HTTP/');
	expect.soft(fetchFrom('http://169.254.169.254/latest/meta-data/')).not.toContain('HTTP/');
	expect.soft(fetchFrom('http://168.63.129.16/machine?comp=goalstate')).not.toContain('HTTP/');

	// 3. Tramline, the agent and Docker on the host: the control plane runs on this machine
	const gateway = run("ip route | awk '/default/ {print $3}'");
	expect(gateway).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
	for (const url of [
		`http://${gateway}:4173/api/agent/v1/desired`,
		`http://${gateway}:4173/api/v1/projects`,
		'http://172.17.0.1:4173/api/v1/projects',
		`http://${gateway}:7172/`,
		`http://${gateway}:2375/version`
	]) {
		expect.soft(fetchFrom(url), url).not.toContain('HTTP/');
	}
	expect.soft(run(`nc -w 2 ${gateway} 22 </dev/null && echo open`)).not.toContain('open');
	// and, had it got there, nothing it could present would pass
	for (const authorization of [undefined, 'Bearer tlnode_forged', 'Bearer tljoin_forged']) {
		const response = await page.request.get('/api/agent/v1/desired', {
			headers: { authorization: authorization ?? '' }
		});
		expect.soft(response.status(), authorization).toBe(401);
	}

	// 4. the other project's service: its name doesn't resolve, and its address gets nothing
	for (const name of ['whoami.production.tramline.internal', 'whoami', 'postgres', 'redis']) {
		expect.soft(run(`nslookup ${name}`), name).not.toMatch(/Name:\s+\S/);
	}
	const victimIp = containerIp(victimEnv, VICTIM);
	expect(victimIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
	expect.soft(fetchFrom(`http://${victimIp}/`)).not.toContain('HTTP/');

	// 5. a scan of the mesh, LAN and CGNAT (Tailscale) ranges, 50 connections at a time
	expect
		.soft(
			run(
				[
					// the mesh is 10.231.0.0/16
					'for net in 10.231.0 10.231.1 10.231.2 10.231.3 10.0.0 10.0.1 10.0.2 10.0.3 192.168.0 192.168.1 192.168.2 192.168.3 100.64.0 100.64.1 100.64.2 100.64.3; do',
					'  for i in $(seq 1 50); do',
					'    nc -w 1 $net.$i 80 </dev/null >/dev/null 2>&1 &',
					'  done; wait',
					'done; echo scanned'
				].join('\n')
			)
		)
		.toContain('scanned');

	// every step shows on the attacker's service, with an alert
	await expect
		.poll(
			async () => {
				const events = (await (
					await page.request.get(`/api/v1/services/${attacker}/security?environmentId=${env}`)
				).json()) as { kind: string }[];
				return [...new Set(events.map((e) => e.kind))].sort();
			},
			{ timeout: 90_000 }
		)
		.toEqual(['host', 'metadata', 'private', 'scan']);
	const openAlert = async (kind: string, serviceId: string) => {
		const alerts = (await (await page.request.get('/api/v1/alerts')).json()) as {
			kind: string;
			serviceId: string | null;
			resolvedAt: string | null;
		}[];
		return alerts.some((a) => a.kind === kind && a.serviceId === serviceId && !a.resolvedAt);
	};
	await expect.poll(() => openAlert('service_security', attacker), { timeout: 90_000 }).toBe(true);

	// 6. a scanner from outside tries the victim's public domain for secrets and admin pages
	const host = new URL(victimUrl!).hostname;
	const paths = ['/.env', '/.git/config', '/wp-login.php', '/.aws/credentials', '/phpinfo.php'];
	for (let i = 0; i < 25; i++) {
		const path = `${paths[i % paths.length]}?n=${i}`;
		await page.request.get(`http://127.0.0.1:${INGRESS_PORT}${path}`, {
			headers: { host, 'user-agent': 'tramline-e2e-scanner' }
		});
	}
	// the victim's owner sees it on the Traffic tab, named by its network, with an alert
	await expect
		.poll(
			async () => {
				const traffic = (await (
					await page.request.get(
						`/api/v1/services/${victim}/traffic?environmentId=${victimEnv}&range=1h&path=.env`
					)
				).json()) as { entries: { userAgent: string | null; network: string | null }[] };
				return traffic.entries.find((e) => e.userAgent === 'tramline-e2e-scanner')?.network;
			},
			{ timeout: 60_000 }
		)
		.toMatch(/^E2E (Loopback|Docker|Private) Net$/);
	await expect.poll(() => openAlert('traffic_scanner', victim), { timeout: 90_000 }).toBe(true);

	// and on the page: the Traffic tab lists the scanner's requests with its network's name
	await page.goto('/');
	await page.getByTestId('project-card').filter({ hasText: 'Victim' }).getByRole('link').click();
	await page.getByTestId('service-node').filter({ hasText: 'whoami' }).click();
	await page.getByTestId('service-panel').getByRole('tab', { name: 'Traffic' }).click();
	await expect(
		page.getByTestId('traffic-entry').filter({ hasText: 'tramline-e2e-scanner' }).first()
	).toContainText(/E2E (Loopback|Docker|Private) Net/);
});
