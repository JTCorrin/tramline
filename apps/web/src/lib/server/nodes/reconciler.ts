import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '../db/client';
import { build, container, deployment, node, service } from '../db/schema';
import { publish } from '../events';
import type { PlatformSettings } from '../settings';
import { notifyNodes } from './bus';
import { systemLog } from './logs';
import { isOnline, ONLINE_WINDOW_MS } from './registry';
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
	const containers = Map.groupBy(
		db.select().from(container).all(),
		(row: ContainerRow) => row.deploymentId
	);
	const builds = new Map(
		db
			.select()
			.from(build)
			.all()
			.map((row) => [row.deploymentId, row])
	);

	// schedule first, so the recreate plan below sees what was just scheduled
	for (const dep of active.filter((d) => d.status === 'queued')) {
		const t = schedule(db, dep, online, nodes, now);
		apply(dep, t);
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

	if (changed.size) {
		notifyNodes();
		announce(db, [...changed.values()]);
	}
	return [...changed.values()];
}

function schedule(
	db: Db,
	dep: DeploymentRow,
	online: (typeof node.$inferSelect)[],
	all: (typeof node.$inferSelect)[],
	now: number
): Transition {
	// a service with a volume runs where its data is
	const pinned = dep.config.volume?.mountPath
		? volumeFor(db, dep.serviceId, dep.environmentId)?.nodeId
		: null;
	if (pinned) {
		const home = all.find((n) => n.id === pinned);
		if (!online.some((n) => n.id === pinned)) {
			return {
				message: `Waiting for ${home?.name ?? 'the node'}, which holds this service's volume`
			};
		}
	}
	// Phase 6 brings real scheduling; until then the first healthy node takes everything
	const target = pinned ? online.find((n) => n.id === pinned) : online[0];
	if (!target) {
		// a node whose agent is connected but can't run containers is the most useful thing to point at
		const broken = all.find(
			(n) => n.error && n.lastSeenAt && now - n.lastSeenAt.getTime() < ONLINE_WINDOW_MS
		);
		return {
			message: broken
				? `Waiting for a node: ${broken.name} reports "${broken.error}"`
				: 'Waiting for a node to come online'
		};
	}
	if (dep.config.source?.type === 'image' && !dep.image && scanMode(dep) !== 'off') {
		return {
			status: 'building',
			nodeId: target.id,
			startedAt: new Date(now),
			message: 'Scanning image',
			log: `Scanning on node ${target.name}`
		};
	}
	if (dep.config.source?.type === 'repo' && !dep.image) {
		return {
			status: 'building',
			nodeId: target.id,
			startedAt: new Date(now),
			message: 'Waiting for the builder',
			log: `Building on node ${target.name}`
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
