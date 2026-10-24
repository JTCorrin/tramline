import { agentEndpoint } from '#lib/server/api/agent.js';
import { secrets } from '#lib/server/api/handler.js';
import { db } from '#lib/server/db/index.js';
import { nextChange } from '#lib/server/nodes/bus.js';
import { attachBackupUrls } from '#lib/server/domain/backups.js';
import { attachBuildTokens } from '#lib/server/github/app.js';
import { buildDesiredState } from '#lib/server/nodes/desired.js';
import { settings } from '#lib/server/settings.server.js';

const LONG_POLL_MS = 25_000;

/**
 * The node's desired state. With `?revision=` the request waits (up to 25s)
 * until the state differs from that revision, then returns it; on timeout it
 * returns 204 and the agent asks again.
 */
export const GET = agentEndpoint(async (node, event) => {
	const known = event.url.searchParams.get('revision');
	const deadline = Date.now() + LONG_POLL_MS;
	for (;;) {
		const desired = buildDesiredState(db, secrets, settings, node.id);
		if (desired.revision !== known)
			return attachBuildTokens(db, secrets, attachBackupUrls(db, secrets, desired));
		const remaining = deadline - Date.now();
		if (remaining <= 0 || event.request.signal.aborted) return undefined;
		await nextChange(remaining, event.request.signal);
	}
});
