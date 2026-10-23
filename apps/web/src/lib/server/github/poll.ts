import type { Secrets } from '../crypto';
import type { Db } from '../db/client';
import {
	deployCommit,
	touchesRoot,
	trackedInstances,
	type TrackedInstance
} from '../domain/autodeploy';
import type { PlatformSettings } from '../settings';
import { branchHead, changedFiles, GitHubError, githubFullName } from './api';
import { installationToken, matchInstallation } from './app';

/** Last ETag and head seen per `repo#branch`, so unchanged branches cost a free 304. */
const heads = new Map<string, { etag: string | null; sha: string }>();
/** The head each instance last acted on (deployed or deliberately skipped). */
const seen = new Map<string, string>();
/** When each anonymously polled branch was last checked. */
const checked = new Map<string, number>();

/**
 * Without the GitHub App, public repositories are polled anonymously, which
 * GitHub limits to 60 requests an hour for the whole install; check them
 * less often.
 */
export const ANONYMOUS_POLL_MS = 5 * 60_000;

/**
 * Checks GitHub for new commits on every tracked branch and deploys them.
 * The fallback when GitHub can't reach this install with webhooks.
 *
 * Only heads it sees change are deployed: an instance whose latest
 * deployment has no commit (e.g. the clone failed) waits for the next push
 * rather than being rebuilt on every poll.
 */
export async function pollRepositories(
	db: Db,
	secrets: Secrets,
	settings: PlatformSettings,
	fetcher?: typeof fetch,
	log: (message: string) => void = console.warn,
	now = Date.now()
) {
	const groups = Map.groupBy(
		trackedInstances(db).filter((t) => githubFullName(t.config.source.repo)),
		(t) => `${githubFullName(t.config.source.repo)}#${t.config.source.branch}`
	);
	const deployed: string[] = [];

	for (const [key, targets] of groups) {
		const [repo, branch] = key.split('#') as [string, string];
		try {
			// an explicit installation, or the organization's installation on the repository owner
			const installationId =
				targets.find((t) => t.config.source.installationId)?.config.source.installationId ??
				matchInstallation(db, targets[0]!.organizationId, targets[0]!.config.source.repo);
			if (!installationId) {
				if (now - (checked.get(key) ?? -Infinity) < ANONYMOUS_POLL_MS) continue;
				checked.set(key, now);
			}
			const token = installationId
				? await installationToken(db, secrets, installationId, fetcher)
				: null;
			const previous = heads.get(key);
			const head = await branchHead(repo, branch, { token, etag: previous?.etag, fetcher });
			const sha = head.changed ? head.sha! : previous!.sha;
			heads.set(key, { etag: head.etag, sha });

			for (const target of targets) {
				const id = await consider(target, sha, repo, token);
				if (id) deployed.push(id);
			}
		} catch (error) {
			const hint =
				error instanceof GitHubError && error.status === 404
					? ' (a private repository? connect the GitHub App in Settings)'
					: '';
			log(`[github] polling ${key}: ${error instanceof Error ? error.message : error}${hint}`);
		}
	}
	return deployed;

	async function consider(
		target: TrackedInstance,
		sha: string,
		repo: string,
		token: string | null
	) {
		const key = `${target.serviceId}:${target.environmentId}`;
		const baseline = seen.get(key) ?? target.latestCommit;
		seen.set(key, sha);
		if (!baseline || baseline === sha) return null;
		const root = target.config.source.rootDirectory;
		if (root.replace(/\//g, '')) {
			const files = await changedFiles(repo, baseline, sha, { token, fetcher });
			if (!touchesRoot(files, root)) return null;
		}
		return deployCommit(
			db,
			secrets,
			settings,
			target,
			sha,
			`New commit ${sha.slice(0, 7)} on ${target.config.source.branch}`
		).id;
	}
}

/** Test seam: forget what was seen. */
export function resetPollState() {
	heads.clear();
	seen.clear();
	checked.clear();
}
