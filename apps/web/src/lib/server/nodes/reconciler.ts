import { and, asc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import type { Db } from '../db/client';
import { build, container, deployment, node, service } from '../db/schema';
import { publish } from '../events';
import type { PlatformSettings } from '../settings';
import { notifyNodes } from './bus';
import { systemLog } from './logs';
import { isOnline, ONLINE_WINDOW_MS, requestedMemory } from './registry';
import { isCron, runCronSchedules } from './cron';
import { ensureVolume, recreatePlan, volumeFor } from './volumes';

/** A replica must stay up this long before a deployment without a healthcheck counts as live. */
export const STABLE_AFTER_MS = 3_000;
/** Give up on a deployment that hasn't gone live after this long. */
export const DEPLOY_TIMEOUT_MS = 10 * 60_000;
/** Give up on a build that hasn't finished after this long. */
export const BUILD_TIMEOUT_MS = 30 * 60_000;
/** Restarts tolerated while deploying before it counts as failed. */
export const STARTUP_RESTARTS = 3;

type DeploymentRow = typeof deployment.$inferSelect;
type ContainerRow = typeof container.$inferSelect;
type BuildRow = typeof build.$inferSelect;
type Status = DeploymentRow['status'];

interface Transition {
	status?: Status;
	message: string | null;
	nodeId?: string;
	startedAt?: Date;
	/** Other columns to update, e.g. the built image. */
	set?: Partial<Pick<DeploymentRow, 'image' | 'resolvedImage' | 'commit' | 'scan'>>;
	/** Written to the deployment's log. */
	log?: string;
}

/**
 * Moves deployments through their lifecycle based on node availability and
 * what agents report:
 *
 *   queued → building → deploying → active ⇄ crashed
 *                  ↘ failed     ↘ failed
 *
 * Source deployments build first, and registry images are pulled and scanned
 * in the same stage unless scanning is off; redeploys of a built or pinned
 * image skip straight to deploying.
 *
 * A deployment going live marks the previous live deployment of the same
 * service and environment `removed`, so its containers are torn down only
 * after the replacement is healthy. Services with a volume are the exception:
 * the old deployment stops first, then the new one starts (see recreatePlan).
 */
export function reconcile(db: Db, settings: PlatformSettings, now = Date.now()) {
	const changed = new Map<string, DeploymentRow>();
	const apply = (dep: DeploymentRow, t: Transition) => {
		const status = t.status ?? dep.status;
		const extra = Object.entries(t.set ?? {}).filter(
			([key, value]) => dep[key as keyof DeploymentRow] !== value
		);
		if (
			status === dep.status &&
			t.message === dep.message &&
			(t.nodeId ?? dep.nodeId) === dep.nodeId &&
			!extra.length
		) {
			return;
		}
		const row = db
			.update(deployment)
			.set({
				status,
				message: t.message,
				nodeId: t.nodeId ?? dep.nodeId,
				startedAt: t.startedAt ?? dep.startedAt,
				...Object.fromEntries(extra)
			})
			.where(eq(deployment.id, dep.id))
			.returning()
			.get()!;
		if (t.log) systemLog(settings.dataDir, dep.id, t.log);
		changed.set(dep.id, row);
	};

	const nodes = db.select().from(node).orderBy(asc(node.createdAt)).all();
	const online = nodes.filter((n) => isOnline(n, now));

	const active = db
		.select()
		.from(deployment)
		.where(inArray(deployment.status, ['queued', 'building', 'deploying', 'active', 'crashed']))
		.orderBy(asc(deployment.createdAt), asc(deployment.id))
		.all();
	// only what the assigned node says counts (recordReport already enforces it). Every
	// deployment, not just live ones: a stopping one's containers hold back its replacement
	const nodeOf = new Map(
		db
			.select({ id: deployment.id, nodeId: deployment.nodeId })
			.from(deployment)
			.all()
			.map((d) => [d.id, d.nodeId])
	);
	const containers = Map.groupBy(
		db
			.select()
			.from(container)
			.all()
			.filter((row: ContainerRow) => nodeOf.get(row.deploymentId) === row.nodeId),
		(row: ContainerRow) => row.deploymentId
	);
	const builds = new Map(
		db
			.select()
			.from(build)
			.all()
			.filter((row) => nodeOf.get(row.deploymentId) === row.nodeId)
			.map((row) => [row.deploymentId, row])
	);

	// schedule first, so the recreate plan below sees what was just scheduled
	const placed = active.filter((d) => d.status !== 'queued' && d.nodeId);
	for (const dep of active.filter((d) => d.status === 'queued')) {
		const t = schedule(db, dep, { online, all: nodes, placed }, now);
		apply(dep, t);
		if (t.nodeId) placed.push({ ...dep, nodeId: t.nodeId });
		// the volume lives on the node the service first ran on
		if (t.nodeId && dep.config.volume?.mountPath) {
			ensureVolume(db, dep.serviceId, dep.environmentId, t.nodeId);
		}
	}
	const current = active.map((dep) => changed.get(dep.id) ?? dep);
	const recreate = recreatePlan(current, new Set(containers.keys()));

	for (const dep of current) {
		const replicas = containers.get(dep.id) ?? [];
		if (dep.status === 'queued') continue;
		if (dep.status === 'building') apply(dep, building(dep, builds.get(dep.id), now));
		else if (dep.status === 'deploying') {
			const t = recreate.waiting.has(dep.id)
				? waitForPrevious(dep, now)
				: progress(dep, replicas, now);
			apply(dep, { ...t, set: pin(dep, replicas) });
			if (t.status === 'active') supersede(db, dep, apply);
		} else if (recreate.stopped.has(dep.id)) {
			apply(dep, { message: `Stopping for ${recreate.stopped.get(dep.id)}` });
		} else apply(dep, { ...health(dep, replicas), set: pin(dep, replicas) });
	}

	const runs = runCronSchedules(db, settings.dataDir, new Date(now));
	if (changed.size || runs.length) {
		notifyNodes();
		announce(db, [...changed.values(), ...runs]);
	}
	return [...changed.values()];
}

type NodeRow = typeof node.$inferSelect;

interface Cluster {
	online: NodeRow[];
	all: NodeRow[];
	/** Deployments already placed (live, or scheduled earlier in this pass). */
	placed: DeploymentRow[];
}

/**
 * Picks a node for a queued deployment.
 *
 * Hard rules: a service with a volume runs where its data is, and a service
 * pinned to a node runs only there, even when that node is cordoned (so a
 * database can always be redeployed, and you can place work on a node you
 * are still checking); cordoned nodes take nothing else; and a deployment
 * with a memory limit needs that much memory free.
 *
 * Then preferences: the node that built the image (others don't have it), a
 * node already running the same environment (its services find each other on
 * one Docker network until the cross-node mesh arrives), and the least loaded.
 */
function schedule(db: Db, dep: DeploymentRow, cluster: Cluster, now: number): Transition {
	const { online, all, placed } = cluster;
	const named = (id: string) => all.find((n) => n.id === id)?.name ?? 'the node';

	// a service with a volume runs where its data is
	const home = dep.config.volume?.mountPath
		? volumeFor(db, dep.serviceId, dep.environmentId)?.nodeId
		: null;
	const pin = dep.config.deploy.node ?? null;
	if (home && pin && home !== pin) {
		return {
			message: `This service's volume is on ${named(home)}, but it is pinned to ${named(pin)}`
		};
	}
	if (pin && !all.some((n) => n.id === pin)) {
		return { message: 'Pinned to a node that no longer exists. Choose another in Settings.' };
	}

	let candidates: NodeRow[];
	if (home) {
		candidates = online.filter((n) => n.id === home);
		if (!candidates.length) {
			return { message: `Waiting for ${named(home)}, which holds this service's volume` };
		}
	} else if (pin) {
		candidates = online.filter((n) => n.id === pin);
		if (!candidates.length) {
			return { message: `Waiting for ${named(pin)}, which this service is pinned to` };
		}
	} else {
		candidates = online.filter((n) => !n.cordoned);
	}

	if (!candidates.length) {
		// a node whose agent is connected but can't run containers is the most useful thing to point at
		const broken = all.find(
			(n) => n.error && n.lastSeenAt && now - n.lastSeenAt.getTime() < ONLINE_WINDOW_MS
		);
		if (broken) return { message: `Waiting for a node: ${broken.name} reports "${broken.error}"` };
		return {
			message: online.length
				? 'Waiting for a node: every online node is cordoned'
				: 'Waiting for a node to come online'
		};
	}

	const others = placed.filter((d) => d.id !== dep.id);
	const allocated = (n: NodeRow) =>
		others.filter((d) => d.nodeId === n.id).reduce((sum, d) => sum + requestedMemory(d.config), 0);
	const wanted = requestedMemory(dep.config);
	// nodes that haven't reported their memory yet are given the benefit of the doubt
	const fits = candidates.filter(
		(n) => !wanted || !n.info?.memoryMb || n.info.memoryMb - allocated(n) >= wanted
	);
	if (!fits.length) {
		return {
			message: `Waiting for a node with ${wanted} MB of memory free`
		};
	}

	// a built image lives on the node that built it; anywhere else builds it again
	const builtOn =
		dep.config.source?.type === 'repo' && dep.image ? builder(db, dep.image) : undefined;
	const sameEnvironment = (n: NodeRow) =>
		others.filter((d) => d.nodeId === n.id && d.environmentId === dep.environmentId).length;
	const load = (n: NodeRow) =>
		n.info?.memoryMb
			? allocated(n) / n.info.memoryMb
			: others.filter((d) => d.nodeId === n.id).length;
	const ranked = fits
		.map((n, order) => ({ n, order }))
		.sort(
			(a, b) =>
				Number(b.n.id === builtOn) - Number(a.n.id === builtOn) ||
				sameEnvironment(b.n) - sameEnvironment(a.n) ||
				load(a.n) - load(b.n) ||
				a.order - b.order
		);
	const target = ranked[0]!.n;
	const rebuild = Boolean(builtOn !== undefined && target.id !== builtOn);
	const image = rebuild ? null : dep.image;

	if (dep.config.source?.type === 'image' && !image && scanMode(dep) !== 'off') {
		return {
			status: 'building',
			nodeId: target.id,
			startedAt: new Date(now),
			message: 'Scanning image',
			log: `Scanning on node ${target.name}`
		};
	}
	if (dep.config.source?.type === 'repo' && !image) {
		return {
			status: 'building',
			nodeId: target.id,
			startedAt: new Date(now),
			message: 'Waiting for the builder',
			log: rebuild
				? `Building on node ${target.name} (the image is on another node)`
				: `Building on node ${target.name}`,
			...(rebuild ? { set: { image: null } } : {})
		};
	}
	return {
		status: 'deploying',
		nodeId: target.id,
		startedAt: new Date(now),
		message: 'Pulling image',
		log: `Scheduled on node ${target.name}`
	};
}

/** The node that built an image: the first deployment that ran it. */
function builder(db: Db, image: string) {
	return (
		db
			.select({ nodeId: deployment.nodeId })
			.from(deployment)
			.where(and(eq(deployment.image, image), isNotNull(deployment.nodeId)))
			.orderBy(asc(deployment.createdAt))
			.limit(1)
			.get()?.nodeId ?? null
	);
}

/** Snapshots taken before scanning existed scan in the default mode. */
const scanMode = (dep: DeploymentRow) => dep.config.build.scan ?? 'warn';

function building(dep: DeploymentRow, report: BuildRow | undefined, now: number): Transition {
	const pulled = dep.config.source?.type === 'image';
	const stage = pulled ? 'Scan' : 'Build';
	if (report?.state === 'succeeded' && report.image) {
		return {
			status: 'deploying',
			startedAt: new Date(now),
			message: 'Starting',
			set: {
				image: report.image,
				commit: report.commit,
				scan: report.scan,
				// a scanned registry image runs by the digest that was scanned
				...(pulled && report.image.includes('@') ? { resolvedImage: report.image } : {})
			},
			log: pulled
				? `Scanned ${report.image}`
				: `Build succeeded${report.commit ? ` (${report.commit.slice(0, 7)})` : ''}`
		};
	}
	if (report?.state === 'failed') {
		const message = report.error ?? `${stage} failed`;
		// keep the commit so polling doesn't rebuild the same broken commit
		return {
			status: 'failed',
			message,
			set: { commit: report.commit, scan: report.scan },
			log: `${stage} failed: ${message}`
		};
	}
	if (now - (dep.startedAt ?? dep.createdAt).getTime() > BUILD_TIMEOUT_MS) {
		return {
			status: 'failed',
			message: pulled ? 'Timed out scanning' : 'Timed out building',
			log: `${stage} timed out`
		};
	}
	if (pulled) return { message: 'Scanning image' };
	return { message: report ? 'Building' : 'Waiting for the builder' };
}

/** Records the digest an image deployment actually runs, so rollbacks reuse that exact image. */
function pin(dep: DeploymentRow, replicas: ContainerRow[]): Transition['set'] {
	if (dep.resolvedImage || dep.config.source?.type !== 'image') return undefined;
	const digest = replicas.find((c) => c.imageDigest)?.imageDigest;
	return digest ? { resolvedImage: digest } : undefined;
}

/** A volume service's new deployment waits for the old one's containers to stop. */
function waitForPrevious(dep: DeploymentRow, now: number): Transition {
	if (now - (dep.startedAt ?? dep.createdAt).getTime() > DEPLOY_TIMEOUT_MS) {
		const message = 'Timed out waiting for the previous deployment to stop';
		return { status: 'failed', message, log: message };
	}
	return { message: 'Waiting for the previous deployment to stop' };
}

function progress(dep: DeploymentRow, replicas: ContainerRow[], now: number): Transition {
	// a cron service has no long-running container: it is live once its schedule is armed
	if (isCron(dep)) return { status: 'active', message: null, log: 'Running on its schedule' };
	const wanted = dep.config.deploy.replicas;
	const failed = replicas.find((c) => c.state === 'error');
	if (failed) return { status: 'failed', message: failed.error, log: `Failed: ${failed.error}` };

	const exited = replicas.find(
		(c) =>
			(c.state === 'exited' && dep.config.deploy.restartPolicy === 'never') ||
			c.restartCount >= STARTUP_RESTARTS
	);
	if (exited) {
		const message = `Crashed during startup (exit code ${exited.exitCode ?? 'unknown'})`;
		return { status: 'failed', message, log: message };
	}

	const healthcheck = dep.config.deploy.healthcheckPath;
	const ready = replicas.filter(
		(c) =>
			c.state === 'running' &&
			(healthcheck
				? c.healthy === true
				: c.startedAt !== null && now - c.startedAt.getTime() >= STABLE_AFTER_MS)
	);
	if (ready.length >= wanted) return { status: 'active', message: null, log: 'Deployment is live' };

	if (now - (dep.startedAt ?? dep.createdAt).getTime() > DEPLOY_TIMEOUT_MS) {
		return {
			status: 'failed',
			message: 'Timed out waiting for the deployment to become healthy',
			log: 'Timed out'
		};
	}
	if (replicas.length < wanted || replicas.some((c) => c.state === 'pulling')) {
		return { message: 'Pulling image' };
	}
	if (healthcheck && replicas.some((c) => c.state === 'running')) {
		return { message: `Waiting for ${healthcheck} to return 200` };
	}
	return { message: 'Starting' };
}

function health(dep: DeploymentRow, replicas: ContainerRow[]): Transition {
	// runs come and go; how each went is recorded on the run
	if (isCron(dep)) return { message: dep.message };
	const running = replicas.filter((c) => c.state === 'running');
	if (dep.status === 'active' && replicas.length && !running.length) {
		const last = replicas[0]!;
		const message = `Crashed (exit code ${last.exitCode ?? 'unknown'})`;
		return { status: 'crashed', message, log: message };
	}
	if (dep.status === 'crashed' && running.length >= dep.config.deploy.replicas) {
		return { status: 'active', message: null, log: 'Recovered' };
	}
	return { message: dep.message };
}

function supersede(db: Db, dep: DeploymentRow, apply: (dep: DeploymentRow, t: Transition) => void) {
	const previous = db
		.select()
		.from(deployment)
		.where(
			and(
				eq(deployment.serviceId, dep.serviceId),
				eq(deployment.environmentId, dep.environmentId),
				ne(deployment.id, dep.id),
				inArray(deployment.status, ['queued', 'building', 'deploying', 'active', 'crashed'])
			)
		)
		.all()
		// only older deployments; a newer one keeps going
		.filter((other) => other.createdAt <= dep.createdAt);
	for (const other of previous) {
		apply(other, {
			status: 'removed',
			message: `Replaced by ${dep.id}`,
			log: `Replaced by ${dep.id}`
		});
	}
}

function announce(db: Db, rows: DeploymentRow[]) {
	const serviceIds = [...new Set(rows.map((r) => r.serviceId))];
	const projects = db
		.select({ id: service.id, projectId: service.projectId })
		.from(service)
		.where(inArray(service.id, serviceIds))
		.all();
	for (const { projectId } of new Map(projects.map((p) => [p.projectId, p])).values()) {
		publish({ type: 'deployments', projectId });
	}
}
