import { AdapterError } from '@tramline/adapter-sdk';
import { createHash, createHmac } from 'node:crypto';
import { at, items, parseXml, text, type XmlNode } from './xml';

/**
 * A small client for the EC2 Query API, signed with AWS Signature Version 4
 * from an access key, so nothing beyond Node is needed.
 */

export interface AccessKey {
	accessKeyId: string;
	secretAccessKey: string;
}

export const EC2_VERSION = '2016-11-15';
export const endpoint = (region: string) => `https://ec2.${region}.amazonaws.com/`;

export interface ClientOptions {
	fetch?: typeof fetch;
	/** The time to sign with; tests fix it. */
	now?: () => Date;
}

/** An EC2 error, with the code AWS gives (`AuthFailure`, `InvalidInstanceID.NotFound`, …). */
export class AwsError extends AdapterError {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string | null
	) {
		super(message);
	}
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) =>
	createHmac('sha256', key).update(value).digest();

/** RFC 3986 encoding, as SigV4 wants it. */
const encode = (value: string) =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);

export class AwsClient {
	readonly #fetch: typeof fetch;

	constructor(
		private key: AccessKey,
		private options: ClientOptions = {}
	) {
		this.#fetch = options.fetch ?? fetch;
	}

	/** Signs a request for `service` in `region` (SigV4, headers form). */
	sign(region: string, service: string, url: URL, body: string) {
		const now = this.options.now?.() ?? new Date();
		const stamp = now
			.toISOString()
			.replace(/[-:]/g, '')
			.replace(/\.\d{3}/, '');
		const day = stamp.slice(0, 8);
		const headers: Record<string, string> = {
			'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
			host: url.host,
			'x-amz-date': stamp
		};
		const signed = Object.keys(headers).sort();
		const canonical = [
			'POST',
			url.pathname,
			'',
			...signed.map((name) => `${name}:${headers[name]}`),
			'',
			signed.join(';'),
			sha256(body)
		].join('\n');
		const scope = `${day}/${region}/${service}/aws4_request`;
		const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
		const signingKey = hmac(
			hmac(hmac(hmac(`AWS4${this.key.secretAccessKey}`, day), region), service),
			'aws4_request'
		);
		const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
		return {
			...headers,
			authorization: `AWS4-HMAC-SHA256 Credential=${this.key.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`
		};
	}

	/** One EC2 action in a region; returns the response's root element. */
	async call(region: string, action: string, params: Record<string, string> = {}) {
		const url = new URL(endpoint(region));
		const body = Object.entries({ Action: action, Version: EC2_VERSION, ...params })
			.map(([name, value]) => `${encode(name)}=${encode(value)}`)
			.join('&');
		let response: Response;
		try {
			response = await this.#fetch(url, {
				method: 'POST',
				headers: this.sign(region, 'ec2', url, body),
				body,
				signal: AbortSignal.timeout(60_000)
			});
		} catch (error) {
			throw new AdapterError(
				`Couldn’t reach AWS: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		const raw = await response.text();
		let root: XmlNode | undefined;
		try {
			root = parseXml(raw).children[0];
		} catch {
			root = undefined;
		}
		if (!response.ok) {
			const error = at(root, 'Errors', 'Error');
			const code = text(error, 'Code');
			throw new AwsError(
				explain(code, text(error, 'Message') ?? `HTTP ${response.status}`, region),
				response.status,
				code
			);
		}
		if (!root) throw new AdapterError(`AWS sent a response that isn’t XML for ${action}`);
		return root;
	}

	/** Every page of an action that pages with NextToken, as one list of a set's items. */
	async all(region: string, action: string, set: string, params: Record<string, string> = {}) {
		const found: XmlNode[] = [];
		let token: string | null = null;
		do {
			const page = await this.call(region, action, {
				...params,
				...(token ? { NextToken: token } : {})
			});
			found.push(...items(page, set));
			token = text(page, 'nextToken');
		} while (token);
		return found;
	}
}

/** EC2's messages, with what to do about the usual ones. */
function explain(code: string | null, message: string, region: string) {
	switch (code) {
		case 'AuthFailure':
		case 'InvalidClientTokenId':
			return 'AWS doesn’t recognise that access key. Check the access key ID, and that the key is active.';
		case 'SignatureDoesNotMatch':
			return 'AWS refused the secret access key. Check you copied all of it.';
		case 'UnauthorizedOperation':
			return `AWS refused: ${message.split(' Encoded authorization failure message')[0]} Attach the policy in docs/adapters/aws.md to the key’s user.`;
		case 'OptInRequired':
			return `The account can’t use ${region} yet: ${message} Enable the region under Account → AWS Regions, or finish signing up.`;
		case 'PendingVerification':
			return 'AWS is still verifying this account; it can create instances once that finishes (usually within minutes, sometimes hours).';
		case 'VcpuLimitExceeded':
			return `The account’s vCPU quota in ${region} doesn’t allow this: ${message} Request more under Service Quotas → EC2, or pick a smaller size.`;
		default:
			return `AWS: ${message}`;
	}
}
