import { eq } from 'drizzle-orm';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiToken, auditEvent, deployment, member } from '../db/schema';
import { seedCtx } from '../testing';
import * as changes from './changes';
import * as deployments from './deployments';
import * as environments from './environments';
import * as oidc from './oidc';
import * as projects from './projects';
import * as services from './services';
import * as tokens from './tokens';

const AUDIENCE = 'https://tramline.example.com';
const NOW = new Date('2026-10-25T12:00:00Z');
const s = Math.floor(NOW.getTime() / 1000);

const github = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = {
	keys: [{ ...github.publicKey.export({ format: 'jwk' }), kid: 'gh-1', alg: 'RS256', use: 'sig' }]
};
const fetcher = vi.fn<typeof fetch>(async () => Response.json(jwks));

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A GitHub Actions OIDC token, signed like GitHub signs them. */
function jwt(
	claims: Partial<oidc.GitHubClaims> = {},
	{
		key = github.privateKey,
		header = { alg: 'RS256', kid: 'gh-1' }
	}: { key?: KeyObject; header?: object } = {}
) {
	const body = {
		iss: oidc.GITHUB_ISSUER,
		aud: AUDIENCE,
		iat: s - 10,
		nbf: s - 10,
		exp: s + 300,
		repository: 'Acme/API',
		repository_id: '1234',
		ref: 'refs/heads/main',
		run_id: '99',
		...claims
	};
	const head = `${b64(header)}.${b64(body)}`;
	return `${head}.${sign('RSA-SHA256', Buffer.from(head), key).toString('base64url')}`;
}

function setup() {
	const ctx = seedCtx();
	ctx.settings = { ...ctx.settings, publicUrl: `${AUDIENCE}/` };
	return ctx;
}

const exchange = (ctx: ReturnType<typeof setup>, token: string, at = NOW) =>
	oidc.exchange(ctx.db, ctx.settings, token, { fetcher, now: at });

beforeEach(() => {
	oidc.resetJwks();
	fetcher.mockClear();
});

describe('GitHub Actions OIDC', () => {
	it('trades a trusted workflow’s token for a short-lived token with the rule’s scopes', async () => {
		const ctx = setup();
		const rule = oidc.createTrust(ctx, {
			repository: 'acme/api',
			refPattern: 'refs/heads/main',
			environment: null,
			scopes: ['deploy']
		});
		const result = await exchange(ctx, jwt());
		expect(result).toMatchObject({
			scopes: ['deploy'],
			expiresAt: new Date(NOW.getTime() + oidc.EXCHANGED_TOKEN_MS).toISOString()
		});
		const issued = tokens.authenticate(ctx.db, result.token, NOW)!;
		expect(issued).toMatchObject({
			organizationId: ctx.organizationId,
			userId: ctx.userId,
			name: 'GitHub Actions · Acme/API@main · run 99'
		});
		// and dies with its expiry
		expect(() =>
			tokens.authenticate(
				ctx.db,
				result.token,
				new Date(NOW.getTime() + oidc.EXCHANGED_TOKEN_MS + 1)
			)
		).toThrow('This token has expired');
		// the repository's id is pinned on first use
		expect(oidc.listTrust(ctx)[0]).toMatchObject({
			id: rule.id,
			repositoryId: '1234',
			lastUsedAt: NOW.toISOString()
		});
		const audit = ctx.db.select().from(auditEvent).all();
		expect(audit).toEqual([
			expect.objectContaining({
				action: 'POST oidc/github',
				params: { repository: 'Acme/API', ref: 'refs/heads/main' }
			})
		]);
	});

	it('refuses tokens that are not GitHub’s, not for this install, or not current', async () => {
		const ctx = setup();
		oidc.createTrust(ctx, {
			repository: 'acme/api',
			refPattern: null,
			environment: null,
			scopes: ['read']
		});
		const refused = (token: string) => expect(exchange(ctx, token)).rejects;
		await refused(jwt({ aud: 'https://evil.example.com' })).toThrow(
			`The token's audience must be ${AUDIENCE}`
		);
		await refused(jwt({ iss: 'https://evil.example.com' })).toThrow(
			'The token is not from GitHub Actions'
		);
		await refused(jwt({ exp: s - 120 })).toThrow('The token has expired');
		await refused(jwt({ nbf: s + 600, iat: s + 600 })).toThrow('The token is not valid yet');
		await refused(jwt({}, { key: attacker.privateKey })).toThrow('The token signature is invalid');
		await refused(jwt({}, { header: { alg: 'none', kid: 'gh-1' } })).toThrow(
			'Unsupported token signature'
		);
		await refused(jwt({}, { header: { alg: 'HS256', kid: 'gh-1' } })).toThrow(
			'Unsupported token signature'
		);
		await refused('not.a.jwt').toThrow('Not a JWT');
		await refused('abc').toThrow('Not a JWT');
		// an unknown key makes it look again (GitHub rotates keys), then gives up
		fetcher.mockClear();
		await refused(jwt({}, { header: { alg: 'RS256', kid: 'unknown' } })).toThrow(
			'The token was not signed by GitHub'
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('matches the repository, ref pattern and environment of a rule', async () => {
		const ctx = setup();
		oidc.createTrust(ctx, {
			repository: 'acme/api',
			refPattern: 'refs/tags/v*',
			environment: 'production',
			scopes: ['deploy']
		});
		const forbidden = (claims: Partial<oidc.GitHubClaims>) =>
			expect(exchange(ctx, jwt(claims))).rejects.toThrow('No trust rule');
		await forbidden({ ref: 'refs/heads/main', environment: 'production' });
		await forbidden({ ref: 'refs/tags/v1.2.0' });
		await forbidden({ ref: 'refs/tags/v1.2.0', environment: 'staging' });
		await forbidden({
			repository: 'acme/other',
			ref: 'refs/tags/v1.2.0',
			environment: 'production'
		});
		await expect(
			exchange(ctx, jwt({ ref: 'refs/tags/v1.2.0', environment: 'production' }))
		).resolves.toMatchObject({
			scopes: ['deploy']
		});
	});

	it('pins the repository id, so a re-created repository with the same name is refused', async () => {
		const ctx = setup();
		oidc.createTrust(ctx, {
			repository: 'acme/api',
			refPattern: null,
			environment: null,
			scopes: ['deploy']
		});
		await exchange(ctx, jwt());
		await expect(exchange(ctx, jwt({ repository_id: '9999' }))).rejects.toThrow(
			'No trust rule lets Acme/API'
		);
	});

	it('needs the install’s URL as the audience', async () => {
		const ctx = setup();
		ctx.settings = { ...ctx.settings, publicUrl: null };
		await expect(exchange(ctx, jwt())).rejects.toThrow(
			'Set TRAMLINE_URL to use GitHub Actions OIDC'
		);
	});

	it('is managed by owners and admins', () => {
		const ctx = setup();
		const rule = oidc.createTrust(ctx, {
			repository: 'acme/api',
			refPattern: null,
			environment: null,
			scopes: ['read']
		});
		ctx.db.update(member).set({ role: 'member' }).where(eq(member.userId, ctx.userId)).run();
		expect(() => oidc.listTrust(ctx)).toThrow(
			'Only organization owners and admins can manage GitHub Actions access'
		);
		expect(() => oidc.removeTrust(ctx, rule.id)).toThrow('Only organization owners and admins');
		ctx.db.update(member).set({ role: 'owner' }).where(eq(member.userId, ctx.userId)).run();
		oidc.removeTrust(ctx, rule.id);
		expect(oidc.listTrust(ctx)).toEqual([]);
		expect(() => oidc.removeTrust(ctx, rule.id)).toThrow('Trust rule not found');
	});

	it('drops exchanged tokens a day after they expire', async () => {
		const ctx = setup();
		oidc.createTrust(ctx, {
			repository: 'acme/api',
			refPattern: null,
			environment: null,
			scopes: ['read']
		});
		await exchange(ctx, jwt());
		oidc.pruneExpiredTokens(ctx.db, new Date(NOW.getTime() + 3600_000));
		expect(ctx.db.select().from(apiToken).all()).toHaveLength(1);
		oidc.pruneExpiredTokens(ctx.db, new Date(NOW.getTime() + 2 * 86_400_000));
		expect(ctx.db.select().from(apiToken).all()).toEqual([]);
	});
});

describe('deploying a service from CI', () => {
	it('deploys the deployed config at an exact commit', () => {
		const ctx = seedCtx();
		const project = projects.create(ctx, { name: 'Shop' });
		const [env] = environments.list(ctx, project.id);
		const api = services.create(ctx, {
			projectId: project.id,
			kind: 'repo',
			source: {
				type: 'repo',
				repo: 'https://github.com/acme/api',
				branch: 'main',
				rootDirectory: '/'
			}
		});
		const deploy = (commit?: string) =>
			deployments.deployService(ctx, { serviceId: api.id, environmentId: env!.id, commit });
		expect(() => deploy()).toThrow("Deploy api's staged changes first");
		changes.deploy(ctx, env!.id);

		const deployed = deploy('abcdef1234567');
		expect(deployed).toMatchObject({
			commit: 'abcdef1234567',
			createdBy: ctx.userId,
			status: 'queued'
		});
		expect(
			ctx.db.select().from(deployment).where(eq(deployment.id, deployed.id)).get()!.commit
		).toBe('abcdef1234567');

		const image = services.create(ctx, {
			projectId: project.id,
			kind: 'image',
			source: { type: 'image', image: 'nginx' }
		});
		changes.deploy(ctx, env!.id);
		expect(() =>
			deployments.deployService(ctx, {
				serviceId: image.id,
				environmentId: env!.id,
				commit: 'abc1234'
			})
		).toThrow('Only services built from a repository take a commit');
		expect(
			deployments.deployService(ctx, { serviceId: image.id, environmentId: env!.id }).commit
		).toBeNull();
	});
});
