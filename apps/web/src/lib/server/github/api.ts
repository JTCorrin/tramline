import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

/**
 * A small GitHub REST client: just what the app integration needs. Every
 * function takes a `fetcher` so tests can stand in for GitHub.
 */
export const GITHUB_API = 'https://api.github.com';

export class GitHubError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

interface RequestOptions {
	token?: string | null;
	method?: string;
	body?: unknown;
	accept?: string;
	etag?: string | null;
	fetcher?: typeof fetch;
}

async function request(path: string, options: RequestOptions = {}) {
	const response = await (options.fetcher ?? globalThis.fetch)(`${GITHUB_API}${path}`, {
		method: options.method ?? 'GET',
		headers: {
			accept: options.accept ?? 'application/vnd.github+json',
			'x-github-api-version': '2022-11-28',
			'user-agent': 'tramline',
			...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
			...(options.etag ? { 'if-none-match': options.etag } : {}),
			...(options.body ? { 'content-type': 'application/json' } : {})
		},
		body: options.body ? JSON.stringify(options.body) : undefined
	});
	if (response.status === 304) return { status: 304, data: null, etag: options.etag ?? null };
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { message?: string } | null;
		throw new GitHubError(
			response.status,
			body?.message ?? `GitHub returned HTTP ${response.status}`
		);
	}
	const text = await response.text();
	const data = text && (options.accept?.includes('sha') ? text.trim() : JSON.parse(text));
	return { status: response.status, data, etag: response.headers.get('etag') };
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** A 9-minute JWT the app uses to act as itself (GitHub allows up to 10). */
export function appJwt(appId: string, privateKey: string, now = Date.now()) {
	const seconds = Math.floor(now / 1000);
	const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	// backdated a minute to tolerate clock drift
	const payload = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }));
	const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
	return `${header}.${payload}.${base64url(signature)}`;
}

export interface ConvertedApp {
	id: number;
	slug: string;
	name: string;
	html_url: string;
	owner: { login: string };
	client_id: string;
	client_secret: string;
	pem: string;
	webhook_secret: string | null;
}

/** Exchanges the code from the manifest flow for the new app's credentials (valid for one hour, once). */
export async function convertManifest(code: string, fetcher?: typeof fetch) {
	const { data } = await request(`/app-manifests/${encodeURIComponent(code)}/conversions`, {
		method: 'POST',
		fetcher
	});
	return data as ConvertedApp;
}

export async function getInstallation(jwt: string, installationId: string, fetcher?: typeof fetch) {
	const { data } = await request(`/app/installations/${encodeURIComponent(installationId)}`, {
		token: jwt,
		fetcher
	});
	return data as { id: number; account: { login: string; type: string }; html_url: string };
}

/** Exchanges the app JWT for a one-hour token scoped to one installation. */
export async function createInstallationToken(
	jwt: string,
	installationId: string,
	fetcher?: typeof fetch
) {
	const { data } = await request(
		`/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
		{ method: 'POST', token: jwt, fetcher }
	);
	return data as { token: string; expires_at: string };
}

export interface InstallationRepo {
	full_name: string;
	private: boolean;
	default_branch: string;
	html_url: string;
}

/** Repositories an installation can access (up to 1,000). */
export async function installationRepos(token: string, fetcher?: typeof fetch) {
	const repos: InstallationRepo[] = [];
	for (let page = 1; page <= 10; page++) {
		const { data } = await request(`/installation/repositories?per_page=100&page=${page}`, {
			token,
			fetcher
		});
		const batch = (data as { repositories: InstallationRepo[] }).repositories;
		repos.push(...batch);
		if (batch.length < 100) break;
	}
	return repos;
}

/**
 * The commit a branch points at. Uses the `sha` media type (a 40-byte body)
 * and the previous ETag, so unchanged branches answer 304, which don't count
 * against the rate limit.
 */
export async function branchHead(
	fullName: string,
	branch: string,
	options: { token?: string | null; etag?: string | null; fetcher?: typeof fetch } = {}
) {
	const { status, data, etag } = await request(
		`/repos/${fullName}/commits/${encodeURIComponent(branch)}`,
		{ ...options, accept: 'application/vnd.github.sha' }
	);
	return { changed: status !== 304, sha: data as string | null, etag };
}

/** Files changed between two commits. */
export async function changedFiles(
	fullName: string,
	base: string,
	head: string,
	options: { token?: string | null; fetcher?: typeof fetch } = {}
) {
	const { data } = await request(`/repos/${fullName}/compare/${base}...${head}`, options);
	return ((data as { files?: { filename: string }[] }).files ?? []).map((file) => file.filename);
}

/** Checks `X-Hub-Signature-256` in constant time. */
export function verifySignature(secret: string, body: string, header: string | null) {
	if (!header?.startsWith('sha256=')) return false;
	const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
	const actual = Buffer.from(header);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** `https://github.com/Acme/API.git` → `acme/api`; null for anything not on github.com. */
export function githubFullName(repo: string) {
	try {
		const url = new URL(repo);
		if (url.hostname !== 'github.com') return null;
		const [owner, name] = url.pathname
			.replace(/^\//, '')
			.replace(/\.git$/, '')
			.split('/');
		return owner && name ? `${owner}/${name}`.toLowerCase() : null;
	} catch {
		return null;
	}
}
