import type { CreateOidcTrust, OidcExchange, OidcTrust } from '@tramline/contracts';
import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';
import { createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';
import { AppError, notFound } from '../api/errors';
import type { DbOrTx } from '../db/client';
import { apiToken, oidcTrust, user } from '../db/schema';
import { newId } from '../ids';
import type { PlatformSettings } from '../settings';
import { requireManager } from './access';
import type { Ctx } from './context';
import { hashToken, record, TOKEN_PREFIX } from './tokens';

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;
/** Exchanged tokens last this long: enough for a deploy step, not for a leak to matter. */
export const EXCHANGED_TOKEN_MS = 15 * 60_000;
/** Allowed clock difference with GitHub. */
const SKEW_S = 60;
const JWKS_TTL_MS = 3600_000;

type Row = typeof oidcTrust.$inferSelect;

/** The audience workflows must request: this install's URL. */
export function audience(settings: PlatformSettings) {
	if (!settings.publicUrl) {
		throw new AppError('conflict', 'Set TRAMLINE_URL to use GitHub Actions OIDC');
	}
	return new URL(settings.publicUrl).origin;
}

// ---- trust rules ---------------------------------------------------------------

function dto(row: Row, creator: { id: string; name: string }): OidcTrust {
	return {
		id: row.id,
		repository: row.repository,
		repositoryId: row.repositoryId,
		refPattern: row.refPattern,
		environment: row.environment,
		scopes: row.scopes,
		createdBy: creator,
		lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString()
	};
}

export function listTrust(ctx: Ctx): OidcTrust[] {
	requireManager(ctx, 'manage GitHub Actions access');
	return ctx.db
		.select({ trust: oidcTrust, creator: { id: user.id, name: user.name } })
		.from(oidcTrust)
		.innerJoin(user, eq(oidcTrust.userId, user.id))
		.where(eq(oidcTrust.organizationId, ctx.organizationId))
		.orderBy(desc(oidcTrust.createdAt))
		.all()
		.map((row) => dto(row.trust, row.creator));
}

export function createTrust(ctx: Ctx, input: CreateOidcTrust): OidcTrust {
	requireManager(ctx, 'manage GitHub Actions access');
	const row = ctx.db
		.insert(oidcTrust)
		.values({
			id: newId('trust'),
			organizationId: ctx.organizationId,
			userId: ctx.userId,
			repository: input.repository,
			refPattern: input.refPattern,
			environment: input.environment,
			scopes: [...new Set(input.scopes)]
		})
		.returning()
		.get();
	const creator = ctx.db
		.select({ id: user.id, name: user.name })
		.from(user)
		.where(eq(user.id, ctx.userId))
		.get()!;
	return dto(row, creator);
}

export function removeTrust(ctx: Ctx, id: string) {
	requireManager(ctx, 'manage GitHub Actions access');
	const removed = ctx.db
		.delete(oidcTrust)
		.where(and(eq(oidcTrust.id, id), eq(oidcTrust.organizationId, ctx.organizationId)))
		.returning({ id: oidcTrust.id })
		.get();
	if (!removed) throw notFound('Trust rule');
}

// ---- verifying GitHub's tokens -------------------------------------------------

/** The claims of a GitHub Actions OIDC token that trust rules look at. */
export interface GitHubClaims {
	iss: string;
	aud: string | string[];
	exp: number;
	iat: number;
	nbf?: number;
	repository: string;
	repository_id: string;
	ref: string;
	environment?: string;
	run_id?: string;
	workflow?: string;
}

let jwks: { keys: (JsonWebKey & { kid?: string })[]; fetchedAt: number } | null = null;

async function signingKey(kid: string, fetcher: typeof fetch, now: number) {
	const find = () => jwks?.keys.find((k) => k.kid === kid);
	// GitHub rotates keys: refetch when the key is unknown or the cache is old
	if (!find() || !jwks || now - jwks.fetchedAt > JWKS_TTL_MS) {
		const response = await fetcher(JWKS_URL);
		if (!response.ok)
			throw new AppError(
				'conflict',
				`Fetching GitHub's signing keys failed: HTTP ${response.status}`
			);
		jwks = { ...((await response.json()) as { keys: JsonWebKey[] }), fetchedAt: now };
	}
	const key = find();
	if (!key) throw new AppError('unauthenticated', 'The token was not signed by GitHub');
	return createPublicKey({ key, format: 'jwk' });
}

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** Verifies an RS256 JWT from GitHub Actions and returns its claims. */
export async function verifyGitHubToken(
	jwt: string,
	expectedAudience: string,
	{ fetcher = fetch, now = Date.now() }: { fetcher?: typeof fetch; now?: number } = {}
): Promise<GitHubClaims> {
	const parts = jwt.split('.');
	if (parts.length !== 3) throw new AppError('unauthenticated', 'Not a JWT');
	let header: { alg?: string; kid?: string };
	let claims: GitHubClaims;
	try {
		header = decode(parts[0]!);
		claims = decode(parts[1]!);
	} catch {
		throw new AppError('unauthenticated', 'Not a JWT');
	}
	// only RS256: never `none`, never an HMAC keyed with a public key
	if (header.alg !== 'RS256' || !header.kid) {
		throw new AppError('unauthenticated', 'Unsupported token signature');
	}
	const key = await signingKey(header.kid, fetcher, now);
	const valid = verify(
		'RSA-SHA256',
		Buffer.from(`${parts[0]}.${parts[1]}`),
		key,
		Buffer.from(parts[2]!, 'base64url')
	);
	if (!valid) throw new AppError('unauthenticated', 'The token signature is invalid');

	const seconds = Math.floor(now / 1000);
	if (claims.iss !== GITHUB_ISSUER)
		throw new AppError('unauthenticated', 'The token is not from GitHub Actions');
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!audiences.includes(expectedAudience)) {
		throw new AppError('unauthenticated', `The token's audience must be ${expectedAudience}`);
	}
	if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < seconds) {
		throw new AppError('unauthenticated', 'The token has expired');
	}
	if ((claims.nbf ?? claims.iat) - SKEW_S > seconds) {
		throw new AppError('unauthenticated', 'The token is not valid yet');
	}
	return claims;
}

/** Test seam: forget cached keys. */
export const resetJwks = () => (jwks = null);

/** `*` matches within a ref segment, `**` across them. */
function refMatches(pattern: string | null, ref: string) {
	if (!pattern) return true;
	const source = pattern
		.split('**')
		.map((part) =>
			part
				.split('*')
				.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
				.join('[^/]*')
		)
		.join('.*');
	return new RegExp(`^${source}$`).test(ref);
}

// ---- the exchange --------------------------------------------------------------

/**
 * Exchanges a GitHub Actions OIDC token for a short-lived API token, if a
 * trust rule allows the workflow's repository, ref and environment.
 */
export async function exchange(
	db: DbOrTx,
	settings: PlatformSettings,
	jwt: string,
	{ fetcher = fetch, now = new Date() }: { fetcher?: typeof fetch; now?: Date } = {}
): Promise<OidcExchange> {
	const claims = await verifyGitHubToken(jwt, audience(settings), { fetcher, now: now.getTime() });
	const repository = claims.repository.toLowerCase();
	const rule = db
		.select()
		.from(oidcTrust)
		.where(eq(oidcTrust.repository, repository))
		.orderBy(oidcTrust.createdAt)
		.all()
		.find(
			(r) =>
				(!r.repositoryId || r.repositoryId === String(claims.repository_id)) &&
				refMatches(r.refPattern, claims.ref) &&
				(!r.environment || r.environment === claims.environment)
		);
	if (!rule) {
		throw new AppError(
			'forbidden',
			`No trust rule lets ${claims.repository} (${claims.ref}${claims.environment ? `, environment ${claims.environment}` : ''}) deploy`
		);
	}

	const secret = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
	const expiresAt = new Date(now.getTime() + EXCHANGED_TOKEN_MS);
	const name = `GitHub Actions · ${claims.repository}@${claims.ref.replace(/^refs\/(heads|tags)\//, '')}${claims.run_id ? ` · run ${claims.run_id}` : ''}`;
	const token = db
		.insert(apiToken)
		.values({
			id: newId('token'),
			organizationId: rule.organizationId,
			userId: rule.userId,
			name: name.slice(0, 120),
			prefix: secret.slice(0, TOKEN_PREFIX.length + 6),
			tokenHash: hashToken(secret),
			scopes: rule.scopes,
			expiresAt
		})
		.returning()
		.get();
	db.update(oidcTrust)
		.set({ lastUsedAt: now, repositoryId: rule.repositoryId ?? String(claims.repository_id) })
		.where(eq(oidcTrust.id, rule.id))
		.run();
	record(
		db,
		{
			organizationId: rule.organizationId,
			userId: rule.userId,
			token: { id: token.id, name: token.name, scopes: token.scopes }
		},
		{
			action: 'POST oidc/github',
			params: { repository: claims.repository, ref: claims.ref },
			status: 201
		},
		now
	);
	return { token: secret, expiresAt: expiresAt.toISOString(), scopes: rule.scopes };
}

/** Exchanged tokens are short-lived; drop them a day after they expire. */
export function pruneExpiredTokens(db: DbOrTx, now = new Date()) {
	db.delete(apiToken)
		.where(
			and(
				isNotNull(apiToken.expiresAt),
				lt(apiToken.expiresAt, new Date(now.getTime() - 86_400_000))
			)
		)
		.run();
}
