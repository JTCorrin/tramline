import type Docker from 'dockerode';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	HELPER_NAME,
	ownContainerId,
	recreateSpec,
	SelfUpdater,
	swapAgent,
	type OwnImage
} from './self-update';
import { FakeRuntime } from './testing';

const ID = 'a'.repeat(64);
const OLD = 'sha256:' + '1'.repeat(64);
const NEW = 'sha256:' + '2'.repeat(64);
const REF = 'ghcr.io/jtcorrin/tramline-agent:latest';

const own = (overrides: Partial<OwnImage> = {}): OwnImage => ({
	containerId: ID,
	reference: REF,
	id: OLD,
	socketBind: '/var/run/docker.sock:/var/run/docker.sock',
	...overrides
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ownContainerId', () => {
	it('reads the ID from the mounts Docker makes for the container', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'mountinfo-'));
		const file = path.join(dir, 'mountinfo');
		writeFileSync(
			file,
			`612 600 0:52 / / rw,relatime - overlay overlay rw\n` +
				`620 612 8:1 /var/lib/docker/containers/${ID}/hostname /etc/hostname rw - ext4 /dev/sda1 rw\n`
		);
		expect(ownContainerId(file, {})).toBe(ID);
	});

	it('is null outside a container, and TRAMLINE_AGENT_CONTAINER overrides it', () => {
		expect(ownContainerId('/nonexistent', {})).toBeNull();
		expect(ownContainerId('/nonexistent', { TRAMLINE_AGENT_CONTAINER: 'agent' })).toBe('agent');
	});
});

describe('SelfUpdater', () => {
	let stateDir: string;
	let runtime: FakeRuntime;
	beforeEach(() => {
		stateDir = mkdtempSync(path.join(tmpdir(), 'self-update-'));
		runtime = new FakeRuntime();
	});
	afterEach(() => vi.useRealTimers());

	const updater = (image: OwnImage | null = own(), settleMs = 0) =>
		new SelfUpdater(runtime, { stateDir, image, log: () => {}, settleMs });
	const saved = () => JSON.parse(readFileSync(path.join(stateDir, 'agent-update.json'), 'utf8'));

	it('reports up to date when the pulled image is the one it runs', async () => {
		runtime.images.set(REF, { id: OLD, created: 1 });
		const u = updater();
		u.want({ id: 'aup_1' });
		expect(u.report).toMatchObject({ id: 'aup_1', state: 'running' });
		await flush();
		expect(runtime.calls).toContain(`pull ${REF}`);
		expect(u.report).toMatchObject({
			state: 'succeeded',
			detail: 'Already up to date (111111111111)'
		});
		expect(runtime.containers.has(HELPER_NAME)).toBe(false);
	});

	it('starts the helper from the new image when there is one, with only the socket', async () => {
		runtime.images.set(REF, { id: NEW, created: 2 });
		const u = updater();
		u.want({ id: 'aup_1' });
		await flush();
		const helper = runtime.containers.get(HELPER_NAME)!.spec;
		expect(helper).toMatchObject({
			image: NEW,
			cmd: ['update', ID, NEW],
			network: 'none',
			binds: ['/var/run/docker.sock:/var/run/docker.sock'],
			autoRemove: true,
			security: { capabilities: [], readOnlyRootFilesystem: true }
		});
		expect(helper.env).toEqual({});
		expect(u.report).toMatchObject({ state: 'running', detail: 'Restarting on 222222222222' });
		expect(saved()).toMatchObject({ state: 'restarting', fromImage: OLD });
	});

	it('never runs the same request twice, even after a restart', async () => {
		runtime.images.set(REF, { id: OLD, created: 1 });
		const u = updater();
		u.want({ id: 'aup_1' });
		await flush();
		u.want({ id: 'aup_1' });
		updater().want({ id: 'aup_1' });
		await flush();
		expect(runtime.calls.filter((c) => c.startsWith('pull'))).toHaveLength(1);
	});

	it('the new agent calls it a success once the helper has kept it', async () => {
		vi.useFakeTimers();
		runtime.images.set(REF, { id: NEW, created: 2 });
		updater().want({ id: 'aup_1' });
		await vi.advanceTimersByTimeAsync(0);
		// the helper swapped containers; the new agent starts on the new image
		const next = updater(own({ id: NEW }), 20_000);
		expect(next.report).toMatchObject({ id: 'aup_1', state: 'running' });
		await vi.advanceTimersByTimeAsync(20_000);
		expect(next.report).toMatchObject({
			state: 'succeeded',
			detail: 'Updated from 111111111111 to 222222222222'
		});
		await vi.advanceTimersByTimeAsync(120_000);
		expect(runtime.calls).toContain(`rmi ${OLD}`);
	});

	it('the old agent, back after a rollback, reports the failure', async () => {
		runtime.images.set(REF, { id: NEW, created: 2 });
		updater().want({ id: 'aup_1' });
		await flush();
		expect(updater(own({ id: OLD })).report).toMatchObject({
			state: 'failed',
			error: "The new agent didn't stay up, so the previous one is running again"
		});
	});

	it('an update cut short by a restart before the swap failed', () => {
		writeFileSync(
			path.join(stateDir, 'agent-update.json'),
			JSON.stringify({ id: 'aup_1', state: 'running' })
		);
		expect(updater().report).toMatchObject({
			state: 'failed',
			error: expect.stringMatching(/restarted/)
		});
	});

	it('fails clearly when it pulls nothing, or runs outside a container', async () => {
		runtime.failPull.set(REF, 'denied');
		const u = updater();
		u.want({ id: 'aup_1' });
		await flush();
		expect(u.report).toMatchObject({ state: 'failed', error: 'denied' });

		const bare = updater(null);
		bare.want({ id: 'aup_2' });
		await flush();
		expect(bare.report).toMatchObject({
			state: 'failed',
			error: expect.stringMatching(/container/)
		});

		const pinned = updater(own({ reference: OLD }));
		pinned.want({ id: 'aup_3' });
		await flush();
		expect(pinned.report).toMatchObject({
			state: 'failed',
			error: expect.stringMatching(/image ID/)
		});
	});
});

describe('recreateSpec', () => {
	it("keeps the container's own settings and drops the image's, and the spent join token", () => {
		const hostConfig = {
			Binds: ['/var/run/docker.sock:/var/run/docker.sock', 'tramline-agent:/var/lib/tramline']
		};
		const spec = recreateSpec(
			{
				Name: '/tramline-agent',
				Config: {
					Hostname: 'vm-100',
					Image: REF,
					Env: [
						'PATH=/usr/bin',
						'TRAMLINE_AGENT_VERSION=old',
						'TRAMLINE_URL=https://tl.example.com',
						'TRAMLINE_JOIN_TOKEN=tljoin_x'
					],
					Labels: { 'org.opencontainers.image.revision': 'old', mine: 'yes' }
				},
				HostConfig: hostConfig
			} as never,
			{
				Env: ['PATH=/usr/bin', 'TRAMLINE_AGENT_VERSION=old'],
				Labels: { 'org.opencontainers.image.revision': 'old' }
			},
			NEW
		);
		expect(spec).toEqual({
			name: 'tramline-agent',
			Image: NEW,
			Hostname: 'vm-100',
			Env: ['TRAMLINE_URL=https://tl.example.com'],
			Labels: { mine: 'yes' },
			HostConfig: hostConfig
		});
	});
});

/** Just enough of dockerode for the swap. */
function fakeDocker(options: { newAgentExits?: boolean } = {}) {
	const events: string[] = [];
	const containers = new Map<string, { name: string; running: boolean }>([
		[ID, { name: 'tramline-agent', running: true }]
	]);
	const handle = (id: string) => ({
		inspect: async () => {
			const c = containers.get(id) ?? [...containers.values()].find((x) => x.name === id);
			if (!c) throw Object.assign(new Error('no such container'), { statusCode: 404 });
			const realId = [...containers].find(([, v]) => v === c)![0];
			return {
				Id: realId,
				Name: `/${c.name}`,
				Image: realId === ID ? OLD : NEW,
				Config: { Hostname: 'vm-100', Image: REF, Env: ['TRAMLINE_URL=u'], Labels: {} },
				HostConfig: { Binds: [] },
				State: { Running: c.running, ExitCode: c.running ? 0 : 1 },
				RestartCount: 0
			};
		},
		rename: async ({ name }: { name: string }) => {
			events.push(`rename ${id} ${name}`);
			containers.get(id)!.name = name;
		},
		stop: async () => {
			events.push(`stop ${id}`);
			containers.get(id)!.running = false;
		},
		start: async () => {
			events.push(`start ${id}`);
			containers.get(id)!.running = !(id === 'new' && options.newAgentExits);
		},
		remove: async () => {
			events.push(`remove ${id}`);
			containers.delete(id);
		}
	});
	const docker = {
		getContainer: handle,
		getImage: () => ({ inspect: async () => ({ Config: { Env: [], Labels: {} } }) }),
		createContainer: async (spec: Docker.ContainerCreateOptions) => {
			events.push(`create ${spec.name} ${spec.Image}`);
			containers.set('new', { name: spec.name!, running: false });
			return handle('new');
		}
	} as unknown as Docker;
	return { docker, events, containers };
}

describe('swapAgent', () => {
	it('starts the new agent under the old name, then removes the old one', async () => {
		const { docker, events, containers } = fakeDocker();
		await swapAgent(docker, ID, NEW, { stableMs: 2, log: () => {} });
		expect(events).toEqual([
			`rename ${ID} tramline-agent-previous`,
			`stop ${ID}`,
			`create tramline-agent ${NEW}`,
			'start new',
			`remove ${ID}`
		]);
		expect([...containers.values()]).toEqual([{ name: 'tramline-agent', running: true }]);
	});

	it('puts the old agent back when the new one stops', async () => {
		const { docker, events, containers } = fakeDocker({ newAgentExits: true });
		await expect(swapAgent(docker, ID, NEW, { stableMs: 2, log: () => {} })).rejects.toThrow(
			/stopped/
		);
		expect(events.slice(-3)).toEqual(['remove new', `rename ${ID} tramline-agent`, `start ${ID}`]);
		expect(containers.get(ID)).toEqual({ name: 'tramline-agent', running: true });
	});
});
