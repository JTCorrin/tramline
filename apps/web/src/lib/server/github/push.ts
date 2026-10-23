import type { Secrets } from '../crypto';
import type { Db } from '../db/client';
import { deployCommit, touchesRoot, trackedInstances } from '../domain/autodeploy';
import type { PlatformSettings } from '../settings';
import { githubFullName } from './api';

export interface PushPayload {
	ref: string;
	after: string;
	deleted?: boolean;
	repository: { full_name: string };
	commits?: { added?: string[]; modified?: string[]; removed?: string[] }[];
	pusher?: { name?: string };
}

/** GitHub lists at most this many commits in a push event; beyond that, assume every path changed. */
const MAX_LISTED_COMMITS = 20;

/** Deploys a pushed commit to every environment tracking that branch. Returns the new deployment IDs. */
export function handlePush(
	db: Db,
	secrets: Secrets,
	settings: PlatformSettings,
	payload: PushPayload
) {
	if (payload.deleted || !payload.ref.startsWith('refs/heads/') || /^0+$/.test(payload.after))
		return [];
	const branch = payload.ref.slice('refs/heads/'.length);
	const repo = payload.repository.full_name.toLowerCase();
	const commits = payload.commits ?? [];
	const files = commits.flatMap((c) => [
		...(c.added ?? []),
		...(c.modified ?? []),
		...(c.removed ?? [])
	]);
	const complete = commits.length > 0 && commits.length < MAX_LISTED_COMMITS;

	const deployed: string[] = [];
	for (const target of trackedInstances(db)) {
		const { source } = target.config;
		if (githubFullName(source.repo) !== repo || source.branch !== branch) continue;
		// webhooks and polling can both see the same commit
		if (target.latestCommit === payload.after) continue;
		if (complete && !touchesRoot(files, source.rootDirectory)) continue;
		const by = payload.pusher?.name ? ` by ${payload.pusher.name}` : '';
		deployed.push(
			deployCommit(
				db,
				secrets,
				settings,
				target,
				payload.after,
				`Push of ${payload.after.slice(0, 7)} to ${branch}${by}`
			).id
		);
	}
	return deployed;
}
