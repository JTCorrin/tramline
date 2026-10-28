import { building } from '$app/env';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { auth } from '#lib/server/auth.js';
import { db } from '#lib/server/db/index.js';
import { onChange } from '#lib/server/nodes/bus.js';
import { reconcile } from '#lib/server/nodes/reconciler.js';
import { ensureLocalNode } from '#lib/server/nodes/registry.js';
import { ensureSetupToken } from '#lib/server/domain/admins.js';
import { securityHeaders } from '#lib/server/security.js';
import { settings } from '#lib/server/settings.server.js';
import { reachableFromInternet } from '#lib/server/settings.js';
import { secrets } from '#lib/server/api/handler.js';
import { pollRepositories } from '#lib/server/github/poll.js';
import { runBackupSchedules } from '#lib/server/domain/backups.js';
import { recheckDomains } from '#lib/server/domain/domains.js';
import { pruneAuditLog } from '#lib/server/domain/tokens.js';
import { pruneExpiredTokens } from '#lib/server/domain/oidc.js';
import { pruneLogs } from '#lib/server/nodes/logs.js';
import { controlPlaneBackups } from '#lib/server/backups/config.server.js';
import { runControlPlaneBackups } from '#lib/server/backups/control-plane-jobs.js';
import { TRAMLINE_GIT_POLL_SECONDS } from '$app/env/private';
import { createInitialModeExpression } from 'mode-watcher';

const RECONCILE_INTERVAL_MS = 2_000;
const BACKUP_SCHEDULE_INTERVAL_MS = 60_000;
const THEME_SCRIPT = createInitialModeExpression({ defaultMode: 'dark' });

export const init: ServerInit = () => {
	if (building) return;
	ensureLocalNode(db, settings.dataDir);
	const setup = ensureSetupToken(db, settings.dataDir);
	if (setup) {
		console.log(
			`[tramline] no install admin yet: sign in, open Nodes, and claim the install with the token in ${setup}`
		);
	}

	// survive dev-server HMR re-running this hook
	const g = globalThis as { __tramlineReconciler?: () => void };
	g.__tramlineReconciler?.();
	const run = () => {
		try {
			reconcile(db, settings);
		} catch (error) {
			console.error('[reconciler]', error);
		}
	};
	const timer = setInterval(run, RECONCILE_INTERVAL_MS);
	const unsubscribe = onChange(() => queueMicrotask(run));

	// with webhooks, polling is only a safety net for missed deliveries
	const pollEvery = (reachableFromInternet(settings) ? 5 : 1) * TRAMLINE_GIT_POLL_SECONDS * 1000;
	let polling = false;
	const poll = setInterval(
		async () => {
			if (polling) return;
			polling = true;
			await pollRepositories(db, secrets, settings).finally(() => (polling = false));
		},
		pollEvery || 2 ** 31 - 1
	);

	// scheduled backups, retention and timed-out jobs; snapshots of this database and drills
	let scheduling = false;
	const schedules = setInterval(async () => {
		if (scheduling) return;
		scheduling = true;
		await runBackupSchedules(db, secrets)
			.then(() => runControlPlaneBackups(db, controlPlaneBackups))
			.then(() => recheckDomains(db))
			.then(() => pruneAuditLog(db))
			.then(() => pruneExpiredTokens(db))
			.then(() => pruneLogs(settings.dataDir))
			.catch((error) => console.error('[backups]', error))
			.finally(() => (scheduling = false));
	}, BACKUP_SCHEDULE_INTERVAL_MS);

	g.__tramlineReconciler = () => {
		clearInterval(timer);
		clearInterval(poll);
		clearInterval(schedules);
		unsubscribe();
	};
};

export const handle: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });
	event.locals.user = session?.user ?? null;
	event.locals.session = session?.session ?? null;

	const response = await svelteKitHandler({
		event,
		resolve: (e) =>
			resolve(e, {
				transformPageChunk: ({ html }) => html.replace('%tramline.theme%', THEME_SCRIPT)
			}),
		auth,
		building
	});
	for (const [name, value] of Object.entries(securityHeaders(event.url))) {
		// streamed and immutable responses (e.g. from better-auth) may have locked headers
		try {
			response.headers.set(name, value);
		} catch {
			return response;
		}
	}
	return response;
};
