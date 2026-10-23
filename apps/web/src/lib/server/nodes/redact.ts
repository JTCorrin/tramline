import { and, eq } from 'drizzle-orm';
import type { Secrets } from '../crypto';
import type { DbOrTx } from '../db/client';
import { deployment } from '../db/schema';
import { sealedKeys } from '../domain/variables';

/** Variable names whose values are treated as secrets even when not sealed. */
const SENSITIVE_KEY =
	/(SECRET|PASSWORD|PASSWD|PASSPHRASE|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_KEY|AUTH|_KEY$|^KEY$|DATABASE_URL|_DSN$)/i;

/** Shorter values (`1`, `true`, `app`) would redact unrelated text. */
const MIN_LENGTH = 6;

/** `scheme://user:password@host` → `scheme://user:[redacted]@host` */
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

export type Redactor = (line: string) => string;

/**
 * Builds a function that scrubs secret values from log lines: values of
 * sealed variables, values of variables with secret-looking names, and
 * passwords embedded in URLs.
 */
export function createRedactor(variables: Record<string, string>, sealed: Set<string>): Redactor {
	const secrets = Object.entries(variables)
		.filter(
			([key, value]) => value.length >= MIN_LENGTH && (sealed.has(key) || SENSITIVE_KEY.test(key))
		)
		// longest first, so a value containing another secret is replaced whole
		.sort((a, b) => b[1].length - a[1].length);

	return (line) => {
		let out = line;
		for (const [key, value] of secrets) {
			if (out.includes(value)) out = out.split(value).join(`[redacted:${key}]`);
		}
		return out.replace(URL_CREDENTIALS, '$1[redacted]@');
	};
}

const CACHE_TTL_MS = 60_000;
const CACHE_SIZE = 200;
const cache = new Map<string, { redact: Redactor; at: number }>();

/** The redactor for a deployment's resolved variables, cached briefly since logs arrive constantly. */
export function redactorFor(db: DbOrTx, secrets: Secrets, deploymentId: string): Redactor {
	const hit = cache.get(deploymentId);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.redact;

	const row = db
		.select({
			variables: deployment.variables,
			serviceId: deployment.serviceId,
			environmentId: deployment.environmentId
		})
		.from(deployment)
		.where(and(eq(deployment.id, deploymentId)))
		.get();
	const redact = row
		? createRedactor(
				JSON.parse(secrets.decrypt(row.variables)) as Record<string, string>,
				sealedKeys(db, row.environmentId, row.serviceId)
			)
		: (line: string) => line;

	if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
	cache.set(deploymentId, { redact, at: Date.now() });
	return redact;
}
