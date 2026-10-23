import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingressName } from './caddy';
import { Converger } from './converge';
import { LABELS } from './runtime';
import { desiredContainer, desiredState, FakeRuntime } from './testing';

const INGRESS_NAME = ingressName('node_1');

function setup() {
	const runtime = new FakeRuntime();
	const stateDir = mkdtempSync(path.join(tmpdir(), 'tramline-agent-'));
	const clock = { now: 1_000_000 };
	const converger = new Converger(runtime, { stateDir, nodeId: 'node_1', now: () => clock.now });
	return { runtime, stateDir, converger, clock };
}

describe('Converger', () => {
	it('creates networks, pulls images and starts containers and the ingress', async () => {
		const { runtime, converger, stateDir } = setup();
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
		expect(ingress.spec.binds?.[0]).toMatch(/caddy:\/etc\/tramline:ro$/);
		expect(ingress.spec.security.capabilities).toEqual(['NET_BIND_SERVICE']);
		const config = JSON.parse(readFileSync(path.join(stateDir, 'caddy', 'caddy.json'), 'utf8'));
		expect(config.apps.http.servers.tramline.routes[0].match[0].host).toEqual([
			'whoami-abc.localhost'
		]);
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
		const { runtime, stateDir } = setup();
		const other = new Converger(runtime, { stateDir, nodeId: 'node_2', drainMs: 0 });
		const mine = new Converger(runtime, { stateDir, nodeId: 'node_1', drainMs: 0 });
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
		const { converger, stateDir } = setup();
		const route = {
			host: 'a.localhost',
			upstreams: ['dep_1.tramline.internal:80'],
			network: 'tl-env_1'
		};
		await converger.run(desiredState(undefined, [route]));
		await converger.run(desiredState([], []));
		const config = JSON.parse(readFileSync(path.join(stateDir, 'caddy', 'caddy.json'), 'utf8'));
		expect(config.apps.http.servers.tramline.routes).toHaveLength(1); // only the 404 fallback
	});

	it('refuses to run before it knows its node', async () => {
		const converger = new Converger(new FakeRuntime(), { stateDir: tmpdir() });
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
});
