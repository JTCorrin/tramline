import { becomeInstallAdmin, createProject, expect, signUp, test } from './helpers';

// an agent joins through the real API and sends samples, as `apps/agent` does every 15 seconds
test("a node's CPU, memory and disk are charted from its agent's samples", async ({
	page,
	request
}) => {
	await becomeInstallAdmin(page);
	const add = page.getByTestId('add-node');
	await add.getByLabel('Name').fill('metrics-box');
	await add.getByRole('button', { name: 'Create join command' }).click();
	const token = (await page.getByTestId('join-command').inputValue()).split('--token ')[1]!;

	const joined = await request.post('/api/agent/v1/join', {
		data: {
			token,
			hello: {
				protocol: 1,
				agentVersion: 'e2e',
				hostname: 'metrics-box',
				os: 'linux',
				arch: 'x64',
				cpus: 4,
				memoryMb: 8000,
				docker: { version: '27.0.0' }
			}
		}
	});
	expect(joined.ok()).toBe(true);
	const { token: nodeToken, nodeId } = (await joined.json()) as { token: string; nodeId: string };
	try {
		expect(
			(await page.request.patch(`/api/v1/nodes/${nodeId}`, { data: { cordoned: true } })).ok()
		).toBe(true);
		const send = (cpuPercent: number) =>
			request.post('/api/agent/v1/metrics', {
				headers: { authorization: `Bearer ${nodeToken}` },
				data: {
					at: new Date().toISOString(),
					node: {
						cpuPercent,
						memoryUsedMb: 3000,
						memoryTotalMb: 8000,
						diskUsedMb: 46_080,
						diskTotalMb: 102_400
					},
					containers: []
				}
			});
		expect((await send(30)).status()).toBe(204);
		expect((await send(30)).status()).toBe(204);
		// samples are checked like every agent request
		const forged = await request.post('/api/agent/v1/metrics', {
			headers: { authorization: 'Bearer tlnode_forged' },
			data: { at: new Date().toISOString(), node: null, containers: [] }
		});
		expect(forged.status()).toBe(401);

		await page.reload();
		const row = page.locator('[data-testid="node-row"][data-node="metrics-box"]');
		await row.getByRole('button', { name: 'Show metrics' }).click();
		const metrics = row.getByTestId('node-metrics');
		const cpu = metrics.getByTestId('metric-panel').filter({ hasText: 'CPU' });
		// Identical samples keep the assertion stable across a minute boundary.
		await expect(cpu).toContainText('30%');
		await expect(metrics.getByTestId('metric-panel').filter({ hasText: 'Memory' })).toContainText(
			'2.9 GB of 7.8 GB'
		);
		await expect(metrics.getByTestId('node-disk')).toContainText('45 GB of 100 GB (45%)');

		// the chart moves through time with the keyboard, and the same numbers come as a table
		const slider = cpu.getByRole('slider');
		await slider.focus();
		await page.keyboard.press('ArrowLeft');
		await expect(slider).toHaveAttribute('aria-valuetext', /CPU 30%/);
		await cpu.getByRole('button', { name: 'Table' }).click();
		await expect(cpu.getByRole('cell', { name: '30%' })).toBeVisible();

		// Switching range must work whether or not the minute job has made an hourly rollup.
		await metrics.getByRole('button', { name: '7d' }).click();
		await expect(metrics.getByRole('button', { name: '7d' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
	} finally {
		expect(
			(
				await page.request.delete(`/api/v1/nodes/${nodeId}`, {
					headers: { origin: new URL(page.url()).origin }
				})
			).ok()
		).toBe(true);
	}
});

test("a service's Metrics tab shows its charts, empty until its deployments report", async ({
	page
}) => {
	await signUp(page);
	await createProject(page, 'Metrics');
	await page.keyboard.press('ControlOrMeta+k');
	await page.getByRole('option', { name: 'Docker Image' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Image').fill('traefik/whoami');
	await dialog.getByRole('button', { name: 'Add service' }).click();
	const panel = page.getByTestId('service-panel');
	await panel.getByRole('tab', { name: 'Metrics' }).click();
	const metrics = panel.getByTestId('service-metrics');
	await expect(metrics.getByTestId('metric-panel')).toHaveCount(3);
	await expect(metrics).toContainText('Minute averages.');
	await expect(metrics.getByTestId('metric-panel').first()).toContainText(
		'No data for this range yet.'
	);
	await metrics.getByRole('button', { name: '30d' }).click();
	await expect(metrics).toContainText('Hourly averages.');

	// the API behind it checks the range and the node
	expect((await page.request.get('/api/v1/alerts')).ok()).toBe(true);
	expect((await page.request.get('/api/v1/nodes/node_nope/metrics')).status()).toBe(404);
});
