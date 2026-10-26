import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deployment, githubApp, githubInstallation, member } from '../db/schema';
import * as changes from '../domain/changes';
import * as environments from '../domain/environments';
import * as projects from '../domain/projects';
import * as services from '../domain/services';
import * as variables from '../domain/variables';
import { seedCtx, testSecrets, testSettings } from '../testing';
import {
	appJwt,
	branchHead,
	changedFiles,
	GitHubError,
	githubFullName,
	installationRepos,
	verifySignature
} from './api';
import {
	attachBuildTokens,
	completeManifest,
	connectInstallation,
	disconnectInstallation,
	installationToken,
	matchInstallation,
	manifestForm,
	repos,
	resetTokenCache,
	status,
	tokenForSource
} from './app';
import { ANONYMOUS_POLL_MS, pollRepositories, resetPollState } from './poll';
import { handlePush } from './push';
import { eq } from 'drizzle-orm';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** A stand-in for api.github.com: routes are `METHOD /path` → response. */
function github(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
	return vi.fn<typeof fetch>(async (input, init) => {
		const url = new URL(String(input));
		const key = `${init?.method ?? 'GET'} ${url.pathname}${url.search}`;
		const route = routes[key] ?? routes[`${init?.method ?? 'GET'} ${url.pathname}`];
		if (!route) return Response.json({ message: `no route ${key}` }, { status: 404 });
		return route(init);
	});
}

function seedApp(ctx = seedCtx()) {
	ctx.db
		.insert(githubApp)
		.values({
			id: '42',
			slug: 'tramline-abc',
			name: 'Tramline abc',
			htmlUrl: 'https://github.com/apps/tramline-abc',
			owner: 'acme',
			clientId: 'Iv1.x',
			clientSecret: testSecrets.encrypt('client-secret'),
			privateKey: testSecrets.encrypt(PEM),
			webhookSecret: testSecrets.encrypt('hook-secret')
		})
		.run();
	return ctx;
}

const tokenRoute = () =>
	Response.json({
		token: 'ghs_install',
		expires_at: new Date(Date.now() + 3_600_000).toISOString()
	});

beforeEach(() => {
	resetTokenCache();
	resetPollState();
});

describe('GitHub API client', () => {
	it('signs app JWTs with RS256 that GitHub can verify', () => {
		const jwt = appJwt('42', PEM, 1_000_000_000_000);
		const [header, payload, signature] = jwt.split('.') as [string, string, string];
		expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
			alg: 'RS256',
			typ: 'JWT'
		});
		expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
			iat: 1_000_000_000 - 60,
			exp: 1_000_000_000 + 540,
			iss: '42'
		});
		const valid = createVerify('RSA-SHA256')
			.update(`${header}.${payload}`)
			.verify(publicKey, Buffer.from(signature, 'base64url'));
		expect(valid).toBe(true);
	});

	it('verifies webhook signatures in constant time', () => {
		const sign = (body: string, secret = 'hook-secret') =>
			`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
		expect(verifySignature('hook-secret', '{"a":1}', sign('{"a":1}'))).toBe(true);
		expect(verifySignature('hook-secret', '{"a":2}', sign('{"a":1}'))).toBe(false);
		expect(verifySignature('hook-secret', '{"a":1}', sign('{"a":1}', 'other'))).toBe(false);
		expect(verifySignature('hook-secret', '{}', null)).toBe(false);
		expect(verifySignature('hook-secret', '{}', 'sha256=short')).toBe(false);
	});

	it('normalises GitHub repository URLs', () => {
		expect(githubFullName('https://github.com/Acme/API.git')).toBe('acme/api');
		expect(githubFullName('https://github.com/acme/api/')).toBe('acme/api');
		expect(githubFullName('https://gitlab.com/acme/api')).toBeNull();
		expect(githubFullName('not a url')).toBeNull();
		expect(githubFullName('https://github.com/acme')).toBeNull();
	});

	it('reads branch heads as bare SHAs and honours ETags', async () => {
		const fetcher = github({
			'GET /repos/acme/api/commits/main': (init) => {
				const headers = init?.headers as Record<string, string>;
				if (headers['if-none-match'] === '"e1"') return new Response(null, { status: 304 });
				expect(headers.accept).toBe('application/vnd.github.sha');
				return new Response(`${SHA_A}\n`, { headers: { etag: '"e1"' } });
			}
		});
		expect(await branchHead('acme/api', 'main', { fetcher })).toEqual({
			changed: true,
			sha: SHA_A,
			etag: '"e1"'
		});
		expect(await branchHead('acme/api', 'main', { fetcher, etag: '"e1"' })).toEqual({
			changed: false,
			sha: null,
			etag: '"e1"'
		});
	});

	it('pages through installation repositories and lists changed files', async () => {
		const page = (n: number, count: number) =>
			Array.from({ length: count }, (_, i) => ({
				full_name: `acme/r${n}-${i}`,
				private: true,
				default_branch: 'main',
				html_url: 'x'
			}));
		const fetcher = github({
			'GET /installation/repositories?per_page=100&page=1': () =>
				Response.json({ repositories: page(1, 100) }),
			'GET /installation/repositories?per_page=100&page=2': () =>
				Response.json({ repositories: page(2, 3) }),
			[`GET /repos/acme/api/compare/${SHA_A}...${SHA_B}`]: () =>
				Response.json({ files: [{ filename: 'web/a.ts' }] })
		});
		expect(await installationRepos('t', fetcher)).toHaveLength(103);
		expect(await changedFiles('acme/api', SHA_A, SHA_B, { fetcher })).toEqual(['web/a.ts']);
	});

	it('raises GitHub errors with their message', async () => {
		const fetcher = github({
			'GET /repos/acme/api/commits/main': () =>
				Response.json({ message: 'Bad credentials' }, { status: 401 })
		});
		await expect(branchHead('acme/api', 'main', { fetcher })).rejects.toEqual(
			new GitHubError(401, 'Bad credentials')
		);
	});
});

describe('GitHub App', () => {
	it('builds a manifest with webhooks only when GitHub can reach the install', () => {
		const ctx = seedCtx();
		const local = manifestForm(ctx, testSettings, 'st', null);
		expect(local.action).toBe('https://github.com/settings/apps/new?state=st');
		const manifest = JSON.parse(local.manifest);
		expect(manifest).toMatchObject({
			redirect_url: 'http://localhost:5173/api/github/manifest',
			setup_url: 'http://localhost:5173/api/github/setup',
			public: false,
			default_permissions: { contents: 'read', metadata: 'read' },
			default_events: []
		});
		expect(manifest).not.toHaveProperty('hook_attributes');

		const hosted = manifestForm(
			ctx,
			{ ...testSettings, publicUrl: 'https://tramline.example.com' },
			'st',
			'acme-inc'
		);
		expect(hosted.action).toBe(
			'https://github.com/organizations/acme-inc/settings/apps/new?state=st'
		);
		expect(JSON.parse(hosted.manifest)).toMatchObject({
			hook_attributes: { url: 'https://tramline.example.com/api/github/webhook', active: true },
			default_events: ['push']
		});

		expect(() => manifestForm(ctx, { ...testSettings, publicUrl: null }, 's')).toThrow(
			'Set TRAMLINE_URL'
		);
	});

	it('only lets owners and admins connect GitHub', () => {
		const ctx = seedCtx();
		ctx.db.update(member).set({ role: 'member' }).where(eq(member.userId, ctx.userId)).run();
		expect(() => manifestForm(ctx, testSettings, 's')).toThrow(
			'Only organization owners and admins'
		);
		expect(status(ctx, testSettings).canManage).toBe(false);
	});

	it('stores the converted app with its secrets encrypted, once', async () => {
		const ctx = seedCtx();
		const fetcher = github({
			'POST /app-manifests/code-1/conversions': () =>
				Response.json({
					id: 7,
					slug: 'tramline-xyz',
					name: 'Tramline xyz',
					html_url: 'https://github.com/apps/tramline-xyz',
					owner: { login: 'acme' },
					client_id: 'Iv1.abc',
					client_secret: 'shh',
					pem: PEM,
					webhook_secret: null
				})
		});
		expect(await completeManifest(ctx, 'code-1', fetcher)).toEqual({ slug: 'tramline-xyz' });
		const row = ctx.db.select().from(githubApp).get()!;
		expect(row.clientSecret).not.toContain('shh');
		expect(testSecrets.decrypt(row.privateKey)).toBe(PEM);
		// no webhooks requested, but a secret is generated so nothing verifies by accident
		expect(testSecrets.decrypt(row.webhookSecret)).toMatch(/^[0-9a-f]{64}$/);
		await expect(completeManifest(ctx, 'code-1', fetcher)).rejects.toThrow('already exists');
		expect(status(ctx, testSettings).app).toEqual({
			name: 'Tramline xyz',
			slug: 'tramline-xyz',
			htmlUrl: 'https://github.com/apps/tramline-xyz'
		});
	});

	it('connects installations to one organization only', async () => {
		const ctx = seedApp();
		const other = seedCtx(ctx.db);
		const fetcher = github({
			'GET /app/installations/99': (init) => {
				expect((init?.headers as Record<string, string>).authorization).toMatch(/^Bearer ey/);
				return Response.json({
					id: 99,
					account: { login: 'acme', type: 'Organization' },
					html_url: 'https://github.com/settings/installations/99'
				});
			}
		});
		await connectInstallation(ctx, '99', fetcher);
		expect(status(ctx, testSettings).installations).toEqual([
			{
				id: '99',
				account: 'acme',
				accountType: 'Organization',
				htmlUrl: 'https://github.com/settings/installations/99'
			}
		]);
		await expect(connectInstallation(other, '99', fetcher)).rejects.toThrow('another organization');
		expect(() => disconnectInstallation(other, '99')).toThrow('Installation not found');
		disconnectInstallation(ctx, '99');
		expect(status(ctx, testSettings).installations).toEqual([]);
	});

	it('mints installation tokens and reuses them until shortly before expiry', async () => {
		const ctx = seedApp();
		const fetcher = github({ 'POST /app/installations/99/access_tokens': tokenRoute });
		expect(await installationToken(ctx.db, testSecrets, '99', fetcher)).toBe('ghs_install');
		await installationToken(ctx.db, testSecrets, '99', fetcher);
		expect(fetcher).toHaveBeenCalledTimes(1);
		// within ten minutes of expiry it fetches a fresh one
		await installationToken(ctx.db, testSecrets, '99', fetcher, Date.now() + 55 * 60_000);
		expect(fetcher).toHaveBeenCalledTimes(2);

		const org = ctx.organizationId;
		const repo = (url: string) =>
			({ type: 'repo', repo: url, branch: 'main', rootDirectory: '/' }) as const;
		expect(
			await tokenForSource(ctx.db, testSecrets, { type: 'image', image: 'x' }, org, fetcher)
		).toBeNull();
		expect(
			await tokenForSource(ctx.db, testSecrets, repo('https://github.com/acme/api'), org, fetcher)
		).toBeNull();
	});

	it('finds the installation for repositories added by URL, within the same organization only', async () => {
		const ctx = seedApp();
		const other = seedCtx(ctx.db);
		ctx.db
			.insert(githubInstallation)
			.values({
				id: '99',
				organizationId: ctx.organizationId,
				account: 'Acme',
				accountType: 'Organization',
				htmlUrl: 'x'
			})
			.run();
		const fetcher = github({ 'POST /app/installations/99/access_tokens': tokenRoute });
		const source = {
			type: 'repo',
			repo: 'https://github.com/acme/private',
			branch: 'main',
			rootDirectory: '/'
		} as const;
		expect(matchInstallation(ctx.db, ctx.organizationId, source.repo)).toBe('99');
		expect(await tokenForSource(ctx.db, testSecrets, source, ctx.organizationId, fetcher)).toBe(
			'ghs_install'
		);
		// another organization can't borrow it
		expect(matchInstallation(ctx.db, other.organizationId, source.repo)).toBeNull();
		expect(
			await tokenForSource(ctx.db, testSecrets, source, other.organizationId, fetcher)
		).toBeNull();
		expect(
			matchInstallation(ctx.db, ctx.organizationId, 'https://github.com/someone-else/repo')
		).toBeNull();
	});

	it('lists repositories across the organization’s installations', async () => {
		const ctx = seedApp();
		ctx.db
			.insert(githubInstallation)
			.values({
				id: '99',
				organizationId: ctx.organizationId,
				account: 'acme',
				accountType: 'Organization',
				htmlUrl: 'x'
			})
			.run();
		const fetcher = github({
			'POST /app/installations/99/access_tokens': tokenRoute,
			'GET /installation/repositories?per_page=100&page=1': () =>
				Response.json({
					repositories: [
						{
							full_name: 'acme/web',
							private: true,
							default_branch: 'trunk',
							html_url: 'https://github.com/acme/web'
						}
					]
				})
		});
		expect(await repos(ctx, fetcher)).toEqual([
			{
				installationId: '99',
				fullName: 'acme/web',
				private: true,
				defaultBranch: 'trunk',
				url: 'https://github.com/acme/web'
			}
		]);
	});
});

/** A project with a repo service deployed once at `commit`. */
function deployedRepo(
	options: {
		rootDirectory?: string;
		installationId?: string | null;
		autoDeploy?: boolean;
		commit?: string | null;
		watchPaths?: string[];
	} = {}
) {
	const ctx = seedApp();
	const project = projects.create(ctx, { name: 'Shop' });
	const [env] = environments.list(ctx, project.id);
	const svc = services.create(ctx, {
		projectId: project.id,
		kind: 'repo',
		source: {
			type: 'repo',
			repo: 'https://github.com/Acme/API.git',
			branch: 'main',
			rootDirectory: options.rootDirectory ?? '/',
			installationId: options.installationId ?? null,
			autoDeploy: options.autoDeploy
		}
	});
	variables.stage(ctx, {
		environmentId: env!.id,
		serviceId: svc.id,
		set: { MODE: 'live' },
		unset: []
	});
	if (options.watchPaths) {
		services.stageConfig(ctx, svc.id, env!.id, { build: { watchPaths: options.watchPaths } });
	}
	const [first] = changes.deploy(ctx, env!.id);
	if (options.commit !== null) {
		ctx.db
			.update(deployment)
			.set({ commit: options.commit ?? SHA_A })
			.where(eq(deployment.id, first!.id))
			.run();
	}
	const deployments = () =>
		ctx.db.select().from(deployment).where(eq(deployment.serviceId, svc.id)).all();
	return { ctx, env: env!, svc, deployments };
}

const push = (overrides: Partial<Parameters<typeof handlePush>[3]> = {}) => ({
	ref: 'refs/heads/main',
	after: SHA_B,
	repository: { full_name: 'acme/api' },
	commits: [{ modified: ['src/index.js'] }],
	pusher: { name: 'octocat' },
	...overrides
});

describe('deploy on push', () => {
	it('deploys the pushed commit with the deployed config and variables, not staged edits', () => {
		const { ctx, env, svc, deployments } = deployedRepo();
		variables.stage(ctx, {
			environmentId: env.id,
			serviceId: svc.id,
			set: { MODE: 'staged-only' },
			unset: []
		});

		const ids = handlePush(ctx.db, testSecrets, testSettings, push());
		expect(ids).toHaveLength(1);
		const created = deployments().find((d) => d.id === ids[0])!;
		expect(created).toMatchObject({ status: 'queued', commit: SHA_B, createdBy: null });
		expect(JSON.parse(testSecrets.decrypt(created.variables)).MODE).toBe('live');
		expect(changes.summary(ctx, env.id).count).toBe(1); // the staged edit is still staged
	});

	it('ignores other repositories, branches, tags, deletions and repeats', () => {
		const { ctx } = deployedRepo();
		const none = (p: object) =>
			expect(handlePush(ctx.db, testSecrets, testSettings, push(p))).toEqual([]);
		none({ repository: { full_name: 'acme/other' } });
		none({ ref: 'refs/heads/develop' });
		none({ ref: 'refs/tags/v1' });
		none({ deleted: true });
		none({ after: SHA_A }); // already deployed
		expect(handlePush(ctx.db, testSecrets, testSettings, push())).toHaveLength(1);
		none({}); // the same push delivered twice
	});

	it('skips pushes outside the root directory, unless the commit list is truncated', () => {
		const { ctx } = deployedRepo({ rootDirectory: '/services/api' });
		expect(
			handlePush(
				ctx.db,
				testSecrets,
				testSettings,
				push({ commits: [{ modified: ['docs/readme.md'] }] })
			)
		).toEqual([]);
		const many = Array.from({ length: 20 }, () => ({ modified: ['docs/readme.md'] }));
		expect(handlePush(ctx.db, testSecrets, testSettings, push({ commits: many }))).toHaveLength(1);
		const { ctx: other } = deployedRepo({ rootDirectory: 'services/api' });
		expect(
			handlePush(
				other.db,
				testSecrets,
				testSettings,
				push({ commits: [{ added: ['services/api/app.js'] }] })
			)
		).toHaveLength(1);
	});

	it('deploys only pushes that touch the watch paths', () => {
		const { ctx } = deployedRepo({ watchPaths: ['src/**', '!**/*.md'] });
		const pushOf = (...files: string[]) =>
			handlePush(ctx.db, testSecrets, testSettings, push({ commits: [{ modified: files }] }));
		expect(pushOf('docs/guide.md', 'README.md')).toEqual([]);
		expect(pushOf('src/notes.md')).toEqual([]);
		expect(pushOf('src/app.ts')).toHaveLength(1);
	});

	it('respects deploy on push being turned off', () => {
		const { ctx } = deployedRepo({ autoDeploy: false });
		expect(handlePush(ctx.db, testSecrets, testSettings, push())).toEqual([]);
	});
});

describe('polling', () => {
	const head = (sha: string) =>
		vi.fn((init?: RequestInit) =>
			(init?.headers as Record<string, string>)['if-none-match'] === `"${sha}"`
				? new Response(null, { status: 304 })
				: new Response(sha, { headers: { etag: `"${sha}"` } })
		);

	it('deploys new commits, once, and uses ETags for unchanged branches', async () => {
		const { ctx, deployments } = deployedRepo({ installationId: '99' });
		let current = SHA_A;
		const route = vi.fn((init?: RequestInit) => head(current)(init));
		const fetcher = github({
			'POST /app/installations/99/access_tokens': tokenRoute,
			'GET /repos/acme/api/commits/main': route
		});
		const poll = () => pollRepositories(ctx.db, testSecrets, testSettings, fetcher);

		expect(await poll()).toEqual([]);
		current = SHA_B;
		const ids = await poll();
		expect(ids).toHaveLength(1);
		expect(deployments().find((d) => d.id === ids[0])?.commit).toBe(SHA_B);
		expect(await poll()).toEqual([]);
		expect(route.mock.results.at(-1)?.value.status).toBe(304);
	});

	it('polls public repositories anonymously at most every five minutes', async () => {
		const { ctx } = deployedRepo();
		const route = vi.fn((init?: RequestInit) => head(SHA_A)(init));
		const fetcher = github({ 'GET /repos/acme/api/commits/main': route });
		const at = (ms: number) =>
			pollRepositories(ctx.db, testSecrets, testSettings, fetcher, undefined, ms);
		await at(0);
		await at(60_000);
		expect(route).toHaveBeenCalledOnce();
		await at(ANONYMOUS_POLL_MS);
		expect(route).toHaveBeenCalledTimes(2);
		expect(
			(route.mock.calls[0]![0]?.headers as Record<string, string>).authorization
		).toBeUndefined();
	});

	it('waits for a new commit when nothing has been built yet', async () => {
		const { ctx } = deployedRepo({ commit: null });
		const fetcher = github({ 'GET /repos/acme/api/commits/main': head(SHA_B) });
		expect(await pollRepositories(ctx.db, testSecrets, testSettings, fetcher)).toEqual([]);
		expect(await pollRepositories(ctx.db, testSecrets, testSettings, fetcher)).toEqual([]);
	});

	it('checks the root directory against the changed files, with the installation token', async () => {
		const { ctx } = deployedRepo({ rootDirectory: 'services/api', installationId: '99' });
		const compare = vi.fn(() => Response.json({ files: [{ filename: 'docs/readme.md' }] }));
		const fetcher = github({
			'POST /app/installations/99/access_tokens': tokenRoute,
			'GET /repos/acme/api/commits/main': (init) => {
				expect((init?.headers as Record<string, string>).authorization).toBe('Bearer ghs_install');
				return new Response(SHA_B);
			},
			[`GET /repos/acme/api/compare/${SHA_A}...${SHA_B}`]: compare
		});
		expect(await pollRepositories(ctx.db, testSecrets, testSettings, fetcher)).toEqual([]);
		expect(compare).toHaveBeenCalledOnce();
	});

	it('logs GitHub errors and carries on', async () => {
		const { ctx } = deployedRepo();
		const log = vi.fn();
		const fetcher = github({
			'GET /repos/acme/api/commits/main': () =>
				Response.json({ message: 'API rate limit exceeded' }, { status: 403 })
		});
		expect(await pollRepositories(ctx.db, testSecrets, testSettings, fetcher, log)).toEqual([]);
		expect(log).toHaveBeenCalledWith(expect.stringContaining('API rate limit exceeded'));
	});
});

describe('build tokens', () => {
	it('gives builds of private repositories a fresh token, and public ones none', async () => {
		const { ctx } = deployedRepo({ installationId: '99' });
		const row = ctx.db.select().from(deployment).get()!;
		const desired = {
			revision: 'r',
			networks: [],
			containers: [],
			ingress: { httpPort: 80, tls: false, routes: [] },
			builds: [
				{
					deploymentId: row.id,
					serviceId: row.serviceId,
					repo: 'x',
					ref: 'main',
					commit: null,
					token: null,
					rootDirectory: '/',
					builder: 'railpack' as const,
					dockerfilePath: null,
					buildCommand: null,
					startCommand: null,
					image: 'i',
					secrets: {},
					scan: 'warn' as const
				}
			],
			scans: [],
			deletedVolumes: [],
			backups: [],
			restores: [],
			drills: [],
			queries: [],
			mesh: null
		};
		const fetcher = github({ 'POST /app/installations/99/access_tokens': tokenRoute });
		const withTokens = await attachBuildTokens(ctx.db, testSecrets, desired, fetcher);
		expect(withTokens.builds[0]!.token).toBe('ghs_install');
		expect(withTokens.revision).toBe('r');
		expect(
			await attachBuildTokens(ctx.db, testSecrets, { ...desired, builds: [] }, fetcher)
		).toEqual({ ...desired, builds: [] });
	});
});
