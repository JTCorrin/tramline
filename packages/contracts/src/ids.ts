/**
 * Every Tramline entity id is a ULID with a short, readable prefix,
 * e.g. `prj_01JB8Z…`. Prefixes make ids self-describing in logs and URLs.
 */
export const ID_PREFIXES = {
	project: 'prj',
	environment: 'env',
	service: 'svc',
	deployment: 'dep',
	variable: 'var',
	node: 'node',
	change: 'chg',
	volume: 'vol',
	backup: 'bak',
	restore: 'rst',
	drill: 'drl',
	domain: 'dom',
	run: 'run',
	token: 'tok'
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
