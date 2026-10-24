import { createHash, createHmac } from 'node:crypto';

/** An S3-compatible bucket: AWS S3, Cloudflare R2, Backblaze B2, MinIO… */
export interface S3Target {
	/** e.g. `https://s3.eu-west-1.amazonaws.com` or `https://<account>.r2.cloudflarestorage.com`. */
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** `endpoint/bucket/key` instead of `bucket.endpoint/key`; MinIO and most self-hosted stores need it. */
	pathStyle: boolean;
}

/** RFC 3986 encoding, as SigV4 requires (`encodeURIComponent` leaves `!'()*` alone). */
const encode = (value: string) =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string) =>
	createHmac('sha256', key).update(value).digest();

/** Where an object lives, path-style or virtual-hosted. */
export function objectUrl(target: S3Target, key: string) {
	const base = new URL(target.endpoint);
	const path = key.split('/').map(encode).join('/');
	if (target.pathStyle) {
		base.pathname = `${base.pathname.replace(/\/$/, '')}/${encode(target.bucket)}/${path}`;
	} else {
		base.hostname = `${target.bucket}.${base.hostname}`;
		base.pathname = `${base.pathname.replace(/\/$/, '')}/${path}`;
	}
	return base;
}

/**
 * A presigned URL (AWS Signature Version 4, query-string authentication):
 * whoever holds it can do exactly `method` on exactly `key` until it expires,
 * without ever seeing the credentials. This is how agents upload and download
 * backups.
 */
export function presign(
	target: S3Target,
	method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
	key: string,
	{ expiresIn = 3600, now = new Date() }: { expiresIn?: number; now?: Date } = {}
) {
	const url = objectUrl(target, key);
	const stamp = now
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}/, '');
	const day = stamp.slice(0, 8);
	const scope = `${day}/${target.region}/s3/aws4_request`;

	const params: [string, string][] = [
		['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
		['X-Amz-Credential', `${target.accessKeyId}/${scope}`],
		['X-Amz-Date', stamp],
		['X-Amz-Expires', String(expiresIn)],
		['X-Amz-SignedHeaders', 'host']
	];
	const query = params
		.map(([k, v]) => [encode(k), encode(v)])
		.sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0))
		.map(([k, v]) => `${k}=${v}`)
		.join('&');

	const canonical = [
		method,
		url.pathname,
		query,
		`host:${url.host}\n`,
		'host',
		'UNSIGNED-PAYLOAD'
	].join('\n');
	const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
	let signingKey = hmac(`AWS4${target.secretAccessKey}`, day);
	for (const part of [target.region, 's3', 'aws4_request']) signingKey = hmac(signingKey, part);
	const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');

	return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${signature}`;
}
