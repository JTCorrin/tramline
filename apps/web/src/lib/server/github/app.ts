import type {
	DesiredState,
	GitHubManifestForm,
	GitHubRepo,
	GitHubStatus,
	ServiceSource
} from '@tramline/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { AppError } from '../api/errors';
import type { Secrets } from '../crypto';
import type { DbOrTx } from '../db/client';
import { deployment, githubApp, githubInstallation, project, service } from '../db/schema';
import { isManager, requireManager as requireOrgManager } from '../domain/access';
import type { Ctx } from '../domain/context';
import { reachableFromInternet, type PlatformSettings } from '../settings';
import {
	appJwt,
	convertManifest,
	githubFullName,
	createInstallationToken,
	getInstallation,
	installationRepos
} from './api';

export interface AppCredentials {
	id: string;
	slug: string;
	name: string;
	htmlUrl: string;
	privateKey: string;
	webhookSecret: string;
}

export function loadApp(db: DbOrTx, secrets: Secrets): AppCredentials | null {
	const row = db.select().from(githubApp).get();
	if (!row) return null;
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		htmlUrl: row.htmlUrl,
		privateKey: secrets.decrypt(row.privateKey),
		webhookSecret: secrets.decrypt(row.webhookSecret)
	};
}

/** Only organization owners and admins connect GitHub. */
const requireManager = (ctx: Ctx) => requireOrgManager(ctx, 'connect GitHub');

function requirePublicUrl(settings: PlatformSettings) {
	if (!settings.publicUrl) {
		throw new AppError(
			'conflict',
			'Set TRAMLINE_URL to this install’s address before connecting GitHub'
		);
	}
	return settings.publicUrl.replace(/\/$/, '');
}

/**
 * The form the browser posts to GitHub to create the app. Webhooks are only
 * requested when GitHub can reach this install; otherwise Tramline polls.
 * `state` is echoed back to the redirect and checked against a cookie.
 */
export function manifestForm(
	ctx: Ctx,
	settings: PlatformSettings,
	state: string,
	owner?: string | null
): GitHubManifestForm {
	requireManager(ctx);
	if (ctx.db.select().from(githubApp).get())
		throw new AppError('conflict', 'A GitHub App already exists');
	const url = requirePublicUrl(settings);
	const webhooks = reachableFromInternet(settings);
	const manifest = {
		// app names are unique across GitHub
		name: `Tramline ${randomBytes(3).toString('hex')}`,
		url,
		redirect_url: `${url}/api/github/manifest`,
		setup_url: `${url}/api/github/setup`,
		setup_on_update: true,
		public: false,
		default_permissions: { contents: 'read', metadata: 'read' },
		...(webhooks
			? {
					hook_attributes: { url: `${url}/api/github/webhook`, active: true },
					default_events: ['push']
				}
			: { default_events: [] })
	};
	const path = owner
		? `/organizations/${encodeURIComponent(owner)}/settings/apps/new`
		: '/settings/apps/new';
	return {
		action: `https://github.com${path}?state=${encodeURIComponent(state)}`,
		manifest: JSON.stringify(manifest)
	};
}

/** Finishes the manifest flow: stores the new app's credentials, encrypted. */
export async function completeManifest(ctx: Ctx, code: string, fetcher?: typeof fetch) {
	requireManager(ctx);
	if (ctx.db.select().from(githubApp).get())
		throw new AppError('conflict', 'A GitHub App already exists');
	const app = await convertManifest(code, fetcher);
	ctx.db
		.insert(githubApp)
		.values({
			id: String(app.id),
			slug: app.slug,
			name: app.name,
			htmlUrl: app.html_url,
			owner: app.owner.login,
			clientId: app.client_id,
			clientSecret: ctx.secrets.encrypt(app.client_secret),
			privateKey: ctx.secrets.encrypt(app.pem),
			// apps without webhooks get no secret from GitHub; keep one so verification never passes by accident
			webhookSecret: ctx.secrets.encrypt(app.webhook_secret ?? randomBytes(32).toString('hex'))
		})
		.run();
	return { slug: app.slug };
}

/** Connects an installation to the caller's organization, after checking it really belongs to the app. */
export async function connectInstallation(
	ctx: Ctx,
	installationId: string,
	fetcher?: typeof fetch
) {
	requireManager(ctx);
	const app = loadApp(ctx.db, ctx.secrets);
	if (!app) throw new AppError('conflict', 'Create the GitHub App first');
	const installation = await getInstallation(
		appJwt(app.id, app.privateKey),
		installationId,
		fetcher
	);

	const existing = ctx.db
		.select()
		.from(githubInstallation)
		.where(eq(githubInstallation.id, installationId))
		.get();
	if (existing && existing.organizationId !== ctx.organizationId) {
		throw new AppError('conflict', 'That installation is connected to another organization');
	}
	const values = {
		account: installation.account.login,
		accountType: installation.account.type,
		htmlUrl: installation.html_url
	};
	ctx.db
		.insert(githubInstallation)
		.values({ id: installationId, organizationId: ctx.organizationId, ...values })
		.onConflictDoUpdate({ target: githubInstallation.id, set: values })
		.run();
}

export function disconnectInstallation(ctx: Ctx, installationId: string) {
	requireManager(ctx);
	const removed = ctx.db
		.delete(githubInstallation)
		.where(
			and(
				eq(githubInstallation.id, installationId),
				eq(githubInstallation.organizationId, ctx.organizationId)
			)
		)
		.returning({ id: githubInstallation.id })
		.get();
	if (!removed) throw new AppError('not_found', 'Installation not found');
}

export function status(ctx: Ctx, settings: PlatformSettings): GitHubStatus {
	const app = ctx.db.select().from(githubApp).get();

	return {
		app: app ? { name: app.name, slug: app.slug, htmlUrl: app.htmlUrl } : null,
		installations: ctx.db
			.select()
			.from(githubInstallation)
			.where(eq(githubInstallation.organizationId, ctx.organizationId))
			.all()
			.map((i) => ({
				id: i.id,
				account: i.account,
				accountType: i.accountType,
				htmlUrl: i.htmlUrl
			})),
		webhooks: reachableFromInternet(settings),
		canManage: isManager(ctx)
	};
}

/** Repositories the organization's installations can access. */
export async function repos(ctx: Ctx, fetcher?: typeof fetch): Promise<GitHubRepo[]> {
	const installations = ctx.db
		.select()
		.from(githubInstallation)
		.where(eq(githubInstallation.organizationId, ctx.organizationId))
		.all();
	const lists = await Promise.all(
		installations.map(async (installation) => {
			const token = await installationToken(ctx.db, ctx.secrets, installation.id, fetcher);
			return (await installationRepos(token, fetcher)).map((repo) => ({
				installationId: installation.id,
				fullName: repo.full_name,
				private: repo.private,
				defaultBranch: repo.default_branch,
				url: repo.html_url
			}));
		})
	);
	return lists.flat().sort((a, b) => a.fullName.localeCompare(b.fullName));
}

const tokens = new Map<string, { token: string; expiresAt: number }>();
/** Refresh tokens this long before GitHub expires them, so a build never starts with a dying one. */
const TOKEN_MARGIN_MS = 10 * 60_000;

/**
 * A one-hour installation token, cached until shortly before it expires.
 * Never stored. With `repository` (a name without its owner) it can only
 * reach that one repository.
 */
export async function installationToken(
	db: DbOrTx,
	secrets: Secrets,
	installationId: string,
	fetcher?: typeof fetch,
	now = Date.now(),
	repository?: string
) {
	const key = `${installationId}:${repository ?? '*'}`;
	const cached = tokens.get(key);
	if (cached && cached.expiresAt - TOKEN_MARGIN_MS > now) return cached.token;
	const app = loadApp(db, secrets);
	if (!app) throw new AppError('conflict', 'The GitHub App is not set up');
	const created = await createInstallationToken(
		appJwt(app.id, app.privateKey, now),
		installationId,
		fetcher,
		repository ? [repository] : undefined
	);
	tokens.set(key, { token: created.token, expiresAt: Date.parse(created.expires_at) });
	return created.token;
}

/** The token a build needs to clone this source, or null for public repositories. */
export async function tokenForSource(
	db: DbOrTx,
	secrets: Secrets,
	source: ServiceSource | null,
	organizationId: string,
	fetcher?: typeof fetch
) {
	if (source?.type !== 'repo') return null;
	// only GitHub repositories over HTTPS ever get a token
	const fullName = githubFullName(source.repo);
	if (!fullName) return null;
	const installationId = source.installationId
		? requireOwnInstallation(db, organizationId, source.installationId)
		: matchInstallation(db, organizationId, source.repo);
	return installationId
		? installationToken(db, secrets, installationId, fetcher, Date.now(), fullName.split('/')[1])
		: null;
}

/**
 * An installation ID only counts when this organization connected that
 * installation; IDs are not credentials.
 */
export function ownsInstallation(db: DbOrTx, organizationId: string, installationId: string) {
	return !!db
		.select({ id: githubInstallation.id })
		.from(githubInstallation)
		.where(
			and(
				eq(githubInstallation.id, installationId),
				eq(githubInstallation.organizationId, organizationId)
			)
		)
		.get();
}

function requireOwnInstallation(db: DbOrTx, organizationId: string, installationId: string) {
	if (!ownsInstallation(db, organizationId, installationId)) {
		throw new AppError(
			'forbidden',
			'That GitHub installation is not connected to this organization'
		);
	}
	return installationId;
}

/**
 * The organization's installation on the GitHub account that owns a
 * repository, for services added by URL before the app was connected.
 * Never crosses organizations.
 */
export function matchInstallation(db: DbOrTx, organizationId: string, repo: string) {
	const owner = githubFullName(repo)?.split('/')[0];
	if (!owner) return null;
	return (
		db
			.select({ id: githubInstallation.id, account: githubInstallation.account })
			.from(githubInstallation)
			.where(eq(githubInstallation.organizationId, organizationId))
			.all()
			.find((installation) => installation.account.toLowerCase() === owner)?.id ?? null
	);
}

/** Test seam: forget cached tokens. */
export const resetTokenCache = () => tokens.clear();

/**
 * Gives each build of a private repository a fresh installation token. Added
 * after the revision is computed, so token refreshes don't wake every agent.
 */
export async function attachBuildTokens(
	db: DbOrTx,
	secrets: Secrets,
	desired: DesiredState,
	fetcher?: typeof fetch
) {
	if (!desired.builds.length) return desired;
	const rows = db
		.select({
			id: deployment.id,
			config: deployment.config,
			organizationId: project.organizationId
		})
		.from(deployment)
		.innerJoin(service, eq(service.id, deployment.serviceId))
		.innerJoin(project, eq(project.id, service.projectId))
		.where(
			inArray(
				deployment.id,
				desired.builds.map((b) => b.deploymentId)
			)
		)
		.all();
	const byId = new Map(rows.map((row) => [row.id, row]));
	const builds = await Promise.all(
		desired.builds.map(async (build) => {
			const row = byId.get(build.deploymentId);
			// a source this organization may not use clones without credentials, and fails if private
			const token = row
				? await tokenForSource(db, secrets, row.config.source, row.organizationId, fetcher).catch(
						() => null
					)
				: null;
			return { ...build, token };
		})
	);
	return { ...desired, builds };
}
