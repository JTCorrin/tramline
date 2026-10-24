import { describe, expect, it } from 'vitest';
import { HealthChecker } from './health';
import { LogShipper } from './logs';
import { observe } from './state';
import { desiredContainer, desiredState, FakeRuntime } from './testing';
import { toRunSpec } from './spec';

const empty = { pulling: new Set<string>(), errors: new Map<string, string>() };

describe('observe', () => {
	it('reports every desired container, including ones not created yet', async () => {
		const runtime = new FakeRuntime();
		const desired = desiredState([
			desiredContainer(),
			desiredContainer({ name: 'tl-dep_1-1', replica: 1 }),
			desiredContainer({ name: 'tl-dep_2-0', deploymentId: 'dep_2', healthcheckPath: '/health' }),
			desiredContainer({ name: 'tl-dep_3-0', deploymentId: 'dep_3' })
		]);
		await runtime.run(toRunSpec(desired.containers[0]!, 'node_1'));
		await runtime.run(toRunSpec(desired.containers[2]!, 'node_1'));
		runtime.containers.get('tl-dep_2-0')!.status = 'exited';
		runtime.containers.get('tl-dep_2-0')!.exitCode = 137;

		const actual = observe(
			desired,
			await runtime.list(),
			{ pulling: new Set(['tl-dep_1-1']), errors: new Map([['tl-dep_3-0', 'pull access denied']]) },
			{ results: new Map() }
		);
		expect(actual.map((c) => [c.name, c.state, c.healthy, c.exitCode, c.error])).toEqual([
			['tl-dep_1-0', 'running', null, null, null],
			['tl-dep_1-1', 'pulling', null, null, null],
			['tl-dep_2-0', 'exited', null, 137, null],
			['tl-dep_3-0', 'error', null, null, 'pull access denied']
		]);
		expect(actual[0]!.startedAt).not.toBeNull();
		expect(actual[2]!.startedAt).toBeNull();
	});
});

describe('HealthChecker', () => {
	it('checks HTTP health through the ingress and forgets stopped containers', async () => {
		const runtime = new FakeRuntime();
		const desired = desiredState([desiredContainer({ healthcheckPath: '/health' })]);
		await runtime.run({ ...toRunSpec(desired.containers[0]!, 'node_1') });
		await runtime.run({
			...toRunSpec(desired.containers[0]!, 'node_1'),
			name: 'tramline-ingress-node_1',
			labels: { 'tramline.role': 'ingress' }
		});
		const health = new HealthChecker(runtime, () => 'tramline-ingress-node_1');

		await health.check(desired, await runtime.list());
		expect(runtime.calls).toContain('exec tramline-ingress-node_1 http://tl-dep_1-0:80/health');
		expect(health.results.get('tl-dep_1-0')).toBe(true);

		runtime.execExit = 1;
		await health.check(desired, await runtime.list());
		expect(health.results.get('tl-dep_1-0')).toBe(false);

		await health.check(desired, []);
		expect(health.results.size).toBe(0);
	});
});

describe('LogShipper', () => {
	it('ships lines in batches and skips lines already sent after re-attaching', async () => {
		const runtime = new FakeRuntime();
		const sent: string[] = [];
		const shipper = new LogShipper(runtime, async (lines) => {
			sent.push(...lines.map((l) => `${l.deploymentId} ${l.stream} ${l.line}`));
		});
		await runtime.run(toRunSpec(desiredContainer(), 'node_1'));

		shipper.sync(await runtime.list());
		const first = runtime.followers.get('tl-dep_1-0')!;
		expect(first.since).toBe(0);
		first.onLine('stdout', '2026-10-23T10:00:01.000Z', 'hello');
		first.onLine('stderr', '2026-10-23T10:00:02.000Z', 'oops');
		await shipper.flush();
		expect(sent).toEqual(['dep_1 stdout hello', 'dep_1 stderr oops']);

		// the container restarted: the stream ended and we re-attach from the last timestamp
		first.onEnd();
		shipper.sync(await runtime.list());
		const second = runtime.followers.get('tl-dep_1-0')!;
		expect(second.since).toBe(Math.floor(Date.parse('2026-10-23T10:00:02.000Z') / 1000));
		second.onLine('stderr', '2026-10-23T10:00:02.000Z', 'oops');
		second.onLine('stdout', '2026-10-23T10:00:03.000Z', 'back');
		await shipper.flush();
		expect(sent.slice(2)).toEqual(['dep_1 stdout back']);

		await runtime.remove('tl-dep_1-0');
		shipper.sync([]);
		expect(runtime.followers.size).toBe(0);
	});

	it('reads a short job that already exited, once', async () => {
		const runtime = new FakeRuntime();
		const sent: string[] = [];
		const shipper = new LogShipper(runtime, async (lines) => {
			sent.push(...lines.map((l) => l.line));
		});
		await runtime.run(toRunSpec(desiredContainer({ name: 'tl-run_1' }), 'node_1'));
		runtime.containers.get('tl-run_1')!.status = 'exited';

		shipper.sync(await runtime.list());
		const follower = runtime.followers.get('tl-run_1')!;
		expect(follower.since).toBe(0);
		follower.onLine('stdout', '2026-10-24T10:00:01.000Z', 'report generated');
		follower.onEnd();
		await shipper.flush();
		expect(sent).toEqual(['report generated']);

		// not re-read on every pass
		runtime.followers.clear();
		shipper.sync(await runtime.list());
		expect(runtime.followers.size).toBe(0);
		// forgotten once it is gone
		await runtime.remove('tl-run_1');
		shipper.sync([]);
	});

	it('keeps lines when sending fails', async () => {
		const runtime = new FakeRuntime();
		let fail = true;
		const sent: string[] = [];
		const shipper = new LogShipper(runtime, async (lines) => {
			if (fail) throw new Error('offline');
			sent.push(...lines.map((l) => l.line));
		});
		await runtime.run(toRunSpec(desiredContainer(), 'node_1'));
		shipper.sync(await runtime.list());
		runtime.followers.get('tl-dep_1-0')!.onLine('stdout', '2026-10-23T10:00:01.000Z', 'a');
		await expect(shipper.flush()).rejects.toThrow('offline');
		fail = false;
		await shipper.flush();
		expect(sent).toEqual(['a']);
		shipper.stop();
	});
});
