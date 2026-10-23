import { building } from '$app/env';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { auth } from '#lib/server/auth.js';
import { db } from '#lib/server/db/index.js';
import { onChange } from '#lib/server/nodes/bus.js';
import { reconcile } from '#lib/server/nodes/reconciler.js';
import { ensureLocalNode } from '#lib/server/nodes/registry.js';
import { settings } from '#lib/server/settings.server.js';

const RECONCILE_INTERVAL_MS = 2_000;

export const init: ServerInit = () => {
	if (building) return;
	ensureLocalNode(db, settings.dataDir);

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
	g.__tramlineReconciler = () => {
		clearInterval(timer);
		unsubscribe();
	};
};

export const handle: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });
	event.locals.user = session?.user ?? null;
	event.locals.session = session?.session ?? null;

	return svelteKitHandler({ event, resolve, auth, building });
};
