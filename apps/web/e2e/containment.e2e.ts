import type { Page } from '@playwright/test';
import {
	ALL_NODES_ONLINE,
	createProject,
	currentEnvironment,
	execIn,
	expect,
	signUp,
	test
} from './helpers';

test.skip(process.env.TRAMLINE_E2E_DOCKER !== '1', 'needs Docker: set TRAMLINE_E2E_DOCKER=1');
test.setTimeout(600_000);

const PROBE = 'busybox:1.37';

/** Adds an image service through the API and stages its settings. */
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
	const service = (await created.json()) as { id: string; name: string };
	const staged = await page.request.patch(
		`/api/v1/services/${service.id}/config?environmentId=${environmentId}`,
		{ data: { build: { scan: 'off' }, ...patch } }
	);
	expect(staged.ok(), await staged.text()).toBe(true);
	return service;
}

test("a service container can't reach the metadata endpoint, the host or the LAN, but reaches its own environment", async ({
	page
}) => {
	await signUp(page);
	await createProject(page, 'Contained');
	await expect(page.getByTestId('node-status')).toHaveText(ALL_NODES_ONLINE, { timeout: 30_000 });
	const env = await currentEnvironment(page);
	const projectId = new URL(page.url()).pathname.split('/').at(-1)!;

	await addService(page, projectId, env, 'traefik/whoami', { networking: { port: 80 } });
	const probe = await addService(page, projectId, env, PROBE, {
		deploy: { startCommand: 'sleep 3600' }
	});
	const deployed = await page.request.post(`/api/v1/environments/${env}/deploy`, { data: {} });
	expect(deployed.ok(), await deployed.text()).toBe(true);
	await expect(page.getByTestId('service-node').filter({ hasText: 'busybox' })).toContainText(
		'Online',
		{ timeout: 540_000 }
	);
	await expect(page.getByTestId('service-node').filter({ hasText: 'whoami' })).toContainText(
		'Online',
		{ timeout: 120_000 }
	);

	// the agent says containment is on
	await expect
		.poll(
			async () => {
				const nodes = (await (await page.request.get('/api/v1/nodes')).json()) as {
					name: string;
					containment: { state: string } | null;
				}[];
				return nodes.find((n) => n.name === 'local')?.containment?.state;
			},
			{ timeout: 60_000 }
		)
		.toBe('active');

	/** What a wget from inside the probe got: an HTTP status line, or nothing but an error. */
	const fetchFrom = (url: string) =>
		execIn(env, PROBE, `wget -T 3 -S -O /dev/null '${url}' 2>&1; true`);

	// its neighbour in the same environment, by its private name
	await expect
		.poll(() => fetchFrom('http://whoami.production.tramline.internal/'), {
			timeout: 30_000
		})
		.toContain('200 OK');
	// names still resolve: the embedded DNS asks the host's resolvers from the container
	expect(execIn(env, PROBE, 'nslookup github.com 2>&1; true')).toMatch(/Address:?\s+\d/);

	// the cloud metadata endpoint gets no answer (on a cloud runner it would)
	expect(fetchFrom('http://169.254.169.254/')).not.toContain('HTTP/');
	// nor do the host's own ports: Tramline itself listens on this machine
	const gateway = execIn(env, PROBE, "ip route | awk '/default/ {print $3}'");
	expect(gateway).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
	expect(fetchFrom(`http://${gateway}:4173/`)).not.toContain('HTTP/');
	// nor another of Docker's networks: the default bridge's gateway is the host too
	expect(fetchFrom('http://172.17.0.1:4173/')).not.toContain('HTTP/');
	// nor anywhere on a private network
	expect(fetchFrom('http://10.255.255.1/')).not.toContain('HTTP/');

	// and each attempt shows on the service, with an alert
	await expect
		.poll(
			async () => {
				const events = (await (
					await page.request.get(`/api/v1/services/${probe.id}/security?environmentId=${env}`)
				).json()) as { kind: string }[];
				return [...new Set(events.map((e) => e.kind))].sort();
			},
			{ timeout: 90_000 }
		)
		.toEqual(['host', 'metadata', 'private']);
	await expect
		.poll(
			async () => {
				const alerts = (await (await page.request.get('/api/v1/alerts')).json()) as {
					kind: string;
					serviceId: string | null;
					resolvedAt: string | null;
				}[];
				return alerts.some(
					(a) => a.kind === 'service_security' && a.serviceId === probe.id && !a.resolvedAt
				);
			},
			{ timeout: 90_000 }
		)
		.toBe(true);
});
