import { describe, expect, it } from 'vitest';
import { INGRESS_CONFIG_PATH, ingressName } from './caddy';
import { Converger, RETRY_FIRST_MS, RETRY_MAX_MS } from './converge';
import { LABELS } from './runtime';
import { desiredContainer, desiredState, FakeRuntime } from './testing';

const INGRESS_NAME = ingressName('node_1');

function setup() {
	const runtime = new FakeRuntime();
	const clock = { now: 1_000_000 };
	const logs: string[] = [];
	const converger = new Converger(runtime, {
		nodeId: 'node_1',
		now: () => clock.now,
		log: (line) => logs.push(line)
	});
	/** The Caddy config the agent last pushed into the ingress. */
	const routes = (node = 'node_1') => {
		const file = runtime.files.get(`${ingressName(node)}:${INGRESS_CONFIG_PATH}`);
		return file ? JSON.parse(file.toString()) : null;
	};
	return { runtime, converger, clock, routes, logs };
}

describe('Converger', () => {
	it('creates networks, pulls images and starts containers and the ingress', async () => {
		const { runtime, converger, routes } = setup();
		const route = {
			host: 'whoami-abc.localhost',
			upstreams: ['dep_1.tramline.internal:80'],
			network: 'tl-env_1'
		};
		await converger.run(desiredState(undefined, [route]));

		expect(runtime.networks).toEqual(new Set(['tl-env_1']));
		expect(runtime.calls).toContain('pull traefik/whoami');
		expect([...runtime.containers.keys()].sort()).toEqual(['tl-dep_1-0', INGRESS_NAME].sort());

		const ingress = runtime.containers.get(INGRESS_NAME)!;
		expect(ingress.spec.ports).toEqual([{ container: 80, host: 8080 }]);
		// no host files are shared with the ingress: routes are pushed into it and reloaded
		expect(ingress.spec.binds).toBeUndefined();
		expect(ingress.spec.cmd).toEqual(['caddy', 'run', '--resume']);
		expect(ingress.spec.security.capabilities).toEqual(['NET_BIND_SERVICE']);
		expect(routes().apps.http.servers.tramline.routes[0].match[0].host).toEqual([
			'whoami-abc.localhost'
		]);
		expect(runtime.calls).toContain(`exec ${INGRESS_NAME} ${INGRESS_CONFIG_PATH}`);
	});

	it('is idempotent', async () => {
		const { runtime, converger } = setup();
		await converger.run(desiredState());
		runtime.calls = [];
		await converger.run(desiredState());
		expect(runtime.calls.filter((c) => /^(run|remove|pull)/.test(c))).toEqual([]);
	});

	it('drains containers that are no longer desired before removing them, but never the ingress', async () => {
		const { runtime, converger, clock } = setup();
		const second = desiredContainer({ name: 'tl-dep_2-0', deploymentId: 'dep_2' });
		await converger.run(desiredState([desiredContainer(), second]));
		await converger.run(desiredState([second]));
		// still serving while the ingress moves traffic away
		expect(runtime.containers.has('tl-dep_1-0')).toBe(true);
		expect(converger.removalDue).toBe(false);

		clock.now += 10_000;
		expect(converger.removalDue).toBe(true);
		await converger.run(desiredState([second]));
		expect([...runtime.containers.keys()].sort()).toEqual(['tl-dep_2-0', INGRESS_NAME].sort());
		expect(converger.removalDue).toBe(false);
	});

	it('stops draining a container that becomes desired again', async () => {
		const { runtime, converger, clock } = setup();
		await converger.run(desiredState());
		await converger.run(desiredState([]));
		await converger.run(desiredState());
		clock.now += 60_000;
		await converger.run(desiredState());
		expect(runtime.containers.has('tl-dep_1-0')).toBe(true);
	});

	it('updates routes before removing the containers they move away from', async () => {
		const { runtime, converger, clock } = setup();
		await converger.run(desiredState());
		await converger.run(
			desiredState([desiredContainer({ name: 'tl-dep_2-0', deploymentId: 'dep_2' })])
		);
		clock.now += 10_000;
		runtime.calls = [];
		const route = {
			host: 'a.localhost',
			upstreams: ['dep_2.tramline.internal:80'],
			network: 'tl-env_1'
		};
		await converger.run(
			desiredState([desiredContainer({ name: 'tl-dep_2-0', deploymentId: 'dep_2' })], [route])
		);
		// the config file is written (no runtime call) before the drained container goes
		expect(runtime.calls.at(-1)).toBe('remove tl-dep_1-0');
	});

	it("never touches another node's containers", async () => {
		const { runtime } = setup();
		const other = new Converger(runtime, { nodeId: 'node_2', drainMs: 0 });
		const mine = new Converger(runtime, { nodeId: 'node_1', drainMs: 0 });
		await other.run(
			desiredState([desiredContainer({ name: 'tl-dep_9-0', deploymentId: 'dep_9' })])
		);
		await mine.run(desiredState());
		await mine.run(desiredState([]));
		expect([...runtime.containers.keys()].sort()).toEqual(
			['tl-dep_9-0', ingressName('node_1'), ingressName('node_2')].sort()
		);
	});

	it('drops routes when the last deployment goes away', async () => {
		const { converger, routes } = setup();
		const route = {
			host: 'a.localhost',
			upstreams: ['dep_1.tramline.internal:80'],
			network: 'tl-env_1'
		};
		await converger.run(desiredState(undefined, [route]));
		await converger.run(desiredState([], []));
		expect(routes().apps.http.servers.tramline.routes).toHaveLength(1); // only the 404 fallback
	});

	it('refuses to run before it knows its node', async () => {
		const converger = new Converger(new FakeRuntime(), {});
		await expect(converger.run(desiredState())).rejects.toThrow('nodeId is not known yet');
	});

	it('replaces a container whose spec changed', async () => {
		const { runtime, converger } = setup();
		await converger.run(desiredState());
		runtime.calls = [];
		await converger.run(desiredState([desiredContainer({ env: { PORT: '81' } })]));
		expect(runtime.calls).toEqual(expect.arrayContaining(['remove tl-dep_1-0', 'run tl-dep_1-0']));
		expect(runtime.containers.get('tl-dep_1-0')!.spec.env).toEqual({ PORT: '81' });
	});

	it('records pull failures instead of throwing, and clears them when no longer desired', async () => {
		const { runtime, converger } = setup();
		runtime.failPull.set('traefik/whoami', 'manifest unknown');
		await converger.run(desiredState());
		expect(converger.errors.get('tl-dep_1-0')).toBe('manifest unknown');
		expect(runtime.containers.has('tl-dep_1-0')).toBe(false);
		expect(converger.pulling.size).toBe(0);

		await converger.run(desiredState([]));
		expect(converger.errors.size).toBe(0);
	});

	it('connects the ingress to new environment networks and recreates it when its port changes', async () => {
		const { runtime, converger } = setup();
		await converger.run(desiredState());
		await converger.run(
			desiredState([
				desiredContainer(),
				desiredContainer({ name: 'tl-dep_2-0', network: 'tl-env_2' })
			])
		);
		expect(runtime.calls).toContain(`connect ${INGRESS_NAME} tl-env_2`);

		const before = runtime.containers.get(INGRESS_NAME)!.labels[LABELS.spec];
		const moved = desiredState();
		moved.ingress.httpPort = 9090;
		await converger.run(moved);
		expect(runtime.containers.get(INGRESS_NAME)!.labels[LABELS.spec]).not.toBe(before);
		expect(runtime.containers.get(INGRESS_NAME)!.spec.ports).toEqual([
			{ container: 80, host: 9090 }
		]);
	});

	it('coalesces overlapping runs into a final run with the latest state', async () => {
		const { runtime, converger } = setup();
		const first = converger.run(desiredState());
		const second = converger.run(
			desiredState([desiredContainer({ name: 'tl-dep_9-0', deploymentId: 'dep_9' })])
		);
		await Promise.all([first, second]);
		expect(runtime.containers.has('tl-dep_9-0')).toBe(true);
		expect(converger.removalDue).toBe(false); // tl-dep_1-0 is draining
	});

	it('creates labelled volumes, and stops stateful workloads gracefully', async () => {
		const { runtime, converger, clock } = setup();
		const db = desiredContainer({
			volumes: [{ name: 'tl-vol_1', target: '/var/lib/postgresql/data' }]
		});
		await converger.run(desiredState([db]));
		expect(runtime.volumes.get('tl-vol_1')).toEqual({
			[LABELS.managed]: 'true',
			[LABELS.node]: 'node_1',
			[LABELS.role]: 'volume'
		});
		const spec = runtime.containers.get('tl-dep_1-0')!.spec;
		expect(spec.volumes).toEqual([{ name: 'tl-vol_1', target: '/var/lib/postgresql/data' }]);
		expect(spec.labels[LABELS.stateful]).toBe('true');
		expect(await converger.volumes()).toEqual(['tl-vol_1']);

		// no longer wanted: drained, then stopped with time to flush before it is removed
		await converger.run(desiredState([]));
		clock.now += 60_000;
		await converger.run(desiredState([]));
		expect(runtime.calls).toContain('stop tl-dep_1-0 30');
		expect(runtime.containers.has('tl-dep_1-0')).toBe(false);
		// the data stays
		expect(runtime.volumes.has('tl-vol_1')).toBe(true);
	});

	it('removes deleted volumes of this node once nothing uses them', async () => {
		const { runtime, converger, clock } = setup();
		const db = desiredContainer({ volumes: [{ name: 'tl-vol_1', target: '/data' }] });
		await converger.run(desiredState([db]));
		runtime.volumes.set('tl-vol_other', { [LABELS.managed]: 'true', [LABELS.node]: 'node_2' });

		// still mounted while the container drains
		const deleted = { ...desiredState([]), deletedVolumes: ['tl-vol_1', 'tl-vol_other'] };
		await converger.run(deleted);
		expect(runtime.volumes.has('tl-vol_1')).toBe(true);

		clock.now += 60_000;
		await converger.run(deleted);
		expect(runtime.volumes.has('tl-vol_1')).toBe(false);
		// another node's volume is never touched
		expect(runtime.volumes.has('tl-vol_other')).toBe(true);
	});

	it('gives stateless workloads a shorter stop timeout', async () => {
		const { runtime, converger, clock } = setup();
		await converger.run(desiredState());
		await converger.run(desiredState([]));
		clock.now += 60_000;
		await converger.run(desiredState([]));
		expect(runtime.calls).toContain('stop tl-dep_1-0 10');
	});

	it('publishes routes straight away, even while another container’s image is still pulling', async () => {
		const { runtime, converger, routes } = setup();
		const live = desiredContainer({ name: 'tl-dep_1-0', deploymentId: 'dep_1' });
		await converger.run(desiredState([live]));

		// a second service's image takes a long time to pull
		let finishPull = () => {};
		const pulling = new Promise<void>((resolve) => (finishPull = resolve));
		const pull = runtime.pull.bind(runtime);
		runtime.pull = async (image) => {
			if (image === 'postgres:17') await pulling;
			return pull(image);
		};
		const slow = desiredContainer({
			name: 'tl-dep_2-0',
			deploymentId: 'dep_2',
			image: 'postgres:17'
		});
		const first = converger.run(desiredState([live, slow]));

		// meanwhile dep_1 goes live and gets a public route
		const route = {
			host: 'whoami-abc.localhost',
			upstreams: ['dep_1.tramline.internal:80'],
			network: 'tl-env_1'
		};
		const second = converger.run(desiredState([live, slow], [route]));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(JSON.stringify(routes())).toContain('whoami-abc.localhost');

		finishPull();
		await Promise.all([first, second]);
		expect(runtime.containers.has('tl-dep_2-0')).toBe(true);
	});

	it('retries routes the ingress refused, and pushes them again to a new ingress', async () => {
		const { runtime, converger, routes, logs } = setup();
		const route = {
			host: 'a.localhost',
			upstreams: ['dep_1.tramline.internal:80'],
			network: 'tl-env_1'
		};
		runtime.execExit = 1;
		await converger.run(desiredState(undefined, [route]));
		expect(logs.some((line) => line.startsWith('the ingress refused its routes'))).toBe(true);

		// accepted on the next pass, and not pushed again while nothing changes
		runtime.execExit = 0;
		await converger.run(desiredState(undefined, [route]));
		const reloads = () =>
			runtime.calls.filter((c) => c === `exec ${INGRESS_NAME} ${INGRESS_CONFIG_PATH}`).length;
		const before = reloads();
		await converger.run(desiredState(undefined, [route]));
		expect(reloads()).toBe(before);

		// the ingress was removed (e.g. by hand): it is recreated and gets its routes again
		await runtime.remove(INGRESS_NAME);
		runtime.files.clear();
		await converger.run(desiredState(undefined, [route]));
		expect(routes().apps.http.servers.tramline.routes[0].match[0].host).toEqual(['a.localhost']);
	});

	it('logs a failure to reach the ingress and carries on', async () => {
		const { runtime, converger, logs } = setup();
		await converger.run(desiredState());
		runtime.putFile = async () => {
			throw new Error('no such container');
		};
		const route = {
			host: 'b.localhost',
			upstreams: ['dep_1.tramline.internal:80'],
			network: 'tl-env_1'
		};
		await converger.run(desiredState(undefined, [route]));
		expect(logs).toContain('updating the ingress failed: no such container');
	});
});

describe('Converger retries', () => {
	it('tries a failed start again after a backoff, and at once for a new spec', async () => {
		const runtime = new FakeRuntime();
		const clock = { now: 1_000_000 };
		const converger = new Converger(runtime, { nodeId: 'node_1', now: () => clock.now });
		runtime.failPull.set('traefik/whoami', 'registry unavailable');

		await converger.run(desiredState());
		expect(converger.errors.get('tl-dep_1-0')).toBe('registry unavailable');
		const pulls = () => runtime.calls.filter((c) => c === 'pull traefik/whoami').length;
		expect(pulls()).toBe(1);

		// too soon: left alone
		clock.now += RETRY_FIRST_MS - 1;
		await converger.run({ ...desiredState(), revision: 'again' });
		expect(pulls()).toBe(1);

		// the registry is back and the backoff is over
		runtime.failPull.delete('traefik/whoami');
		clock.now += 1;
		await converger.run({ ...desiredState(), revision: 'later' });
		expect(runtime.containers.has('tl-dep_1-0')).toBe(true);
		expect(converger.errors.has('tl-dep_1-0')).toBe(false);
	});

	it('backs off further after each failure, up to a limit', async () => {
		const runtime = new FakeRuntime();
		const clock = { now: 0 };
		const converger = new Converger(runtime, { nodeId: 'node_1', now: () => clock.now });
		runtime.failPull.set('traefik/whoami', 'nope');
		const pulls = () => runtime.calls.filter((c) => c === 'pull traefik/whoami').length;
		await converger.run(desiredState());
		clock.now += RETRY_FIRST_MS;
		await converger.run({ ...desiredState(), revision: '2' });
		expect(pulls()).toBe(2);
		clock.now += RETRY_FIRST_MS;
		await converger.run({ ...desiredState(), revision: '3' });
		expect(pulls()).toBe(2);
		clock.now += RETRY_MAX_MS;
		await converger.run({ ...desiredState(), revision: '4' });
		expect(pulls()).toBe(3);

		// a different spec is a fresh start
		await converger.run(desiredState([desiredContainer({ image: 'traefik/whoami:v2' })]));
		expect(runtime.calls).toContain('pull traefik/whoami:v2');
	});
});
