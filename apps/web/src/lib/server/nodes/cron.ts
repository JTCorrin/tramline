import { and, desc, eq, inArray } from 'drizzle-orm';
import { nextRun, parseCron } from '../cron';
import type { DbOrTx } from '../db/client';
import { container, cronRun, deployment } from '../db/schema';
import { newId } from '../ids';
import { systemLog } from './logs';

type DeploymentRow = typeof deployment.$inferSelect;
type RunRow = typeof cronRun.$inferSelect;

/** A run that hasn't finished after this long is stopped and failed. */
export const RUN_TIMEOUT_MS = 24 * 3600_000;

export const runContainerName = (runId: string) => `tl-${runId}`;

export const isCron = (dep: Pick<DeploymentRow, 'config'>) => !!dep.config.deploy.cronSchedule;

/** When a cron deployment runs next, or null for other deployments (or a schedule that never fires). */
export function nextRunAt(db: DbOrTx, dep: DeploymentRow, now = new Date()) {
	if (!isCron(dep) || !['active', 'crashed'].includes(dep.status)) return null;
	const last = lastRun(db, dep.id);
	const after = last?.scheduledFor ?? dep.startedAt ?? dep.createdAt;
	return nextRun(parseCron(dep.config.deploy.cronSchedule!), after < now ? now : after);
}

function lastRun(db: DbOrTx, deploymentId: string): RunRow | undefined {
	return db
		.select()
		.from(cronRun)
		.where(and(eq(cronRun.deploymentId, deploymentId), eq(cronRun.trigger, 'schedule')))
		.orderBy(desc(cronRun.scheduledFor))
		.get();
}

/** Runs in flight, whose containers belong in the desired state. */
export function runningRuns(db: DbOrTx, deploymentIds: string[]) {
	if (!deploymentIds.length) return [];
	return db
		.select()
		.from(cronRun)
		.where(and(inArray(cronRun.deploymentId, deploymentIds), eq(cronRun.status, 'running')))
		.orderBy(cronRun.id)
		.all();
}

export function startRun(
	db: DbOrTx,
	dataDir: string,
	dep: DeploymentRow,
	trigger: RunRow['trigger'],
	scheduledFor: Date
) {
	const busy = runningRuns(db, [dep.id]).length > 0;
	const row = db
		.insert(cronRun)
		.values({
			id: newId('run'),
			deploymentId: dep.id,
			trigger,
			// runs never overlap: a slot that comes round while one is going is skipped
			status: busy ? 'skipped' : 'running',
			scheduledFor,
			finishedAt: busy ? scheduledFor : null
		})
		.returning()
		.get();
	systemLog(
		dataDir,
		dep.id,
		busy
			? `Skipped the run for ${scheduledFor.toISOString()}: the previous run is still going`
			: `Run ${row.id} started${trigger === 'manual' ? ' by hand' : ''}`
	);
	return row;
}

/**
 * Starts the runs that are due, and finishes the ones whose container has
 * exited. Returns the deployments whose runs changed, so agents and the UI
 * can be told.
 */
export function runCronSchedules(db: DbOrTx, dataDir: string, now = new Date()) {
	const changed = new Map<string, DeploymentRow>();
	const deployments = db
		.select()
		.from(deployment)
		.where(inArray(deployment.status, ['active', 'crashed']))
		.all()
		.filter(isCron);

	for (const dep of deployments) {
		const cron = parseCron(dep.config.deploy.cronSchedule!);
		const last = lastRun(db, dep.id);
		let slot = nextRun(cron, last?.scheduledFor ?? dep.startedAt ?? dep.createdAt);
		if (!slot || slot > now) continue;
		// after downtime, missed slots collapse into one run
		for (let next = nextRun(cron, slot); next && next <= now; next = nextRun(cron, slot)) {
			slot = next;
		}
		startRun(db, dataDir, dep, 'schedule', slot);
		changed.set(dep.id, dep);
	}

	const running = db.select().from(cronRun).where(eq(cronRun.status, 'running')).all();
	for (const run of running) {
		const reported = db
			.select()
			.from(container)
			.where(eq(container.name, runContainerName(run.id)))
			.get();
		const finished =
			reported && (reported.state === 'exited' || reported.state === 'error')
				? {
						status: reported.exitCode === 0 ? ('succeeded' as const) : ('failed' as const),
						exitCode: reported.exitCode,
						error: reported.error
					}
				: now.getTime() - run.scheduledFor.getTime() > RUN_TIMEOUT_MS
					? { status: 'failed' as const, exitCode: null, error: 'Timed out' }
					: null;
		if (!finished) continue;
		db.update(cronRun)
			.set({ ...finished, finishedAt: now })
			.where(eq(cronRun.id, run.id))
			.run();
		systemLog(
			dataDir,
			run.deploymentId,
			finished.status === 'succeeded'
				? `Run ${run.id} finished`
				: `Run ${run.id} failed${finished.exitCode !== null ? ` (exit code ${finished.exitCode})` : `: ${finished.error}`}`
		);
		const dep = db.select().from(deployment).where(eq(deployment.id, run.deploymentId)).get();
		if (dep) changed.set(dep.id, dep);
	}
	return [...changed.values()];
}
