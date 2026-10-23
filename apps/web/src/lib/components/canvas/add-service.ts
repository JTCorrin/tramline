import type { DatabaseEngine } from '@tramline/contracts';

/** What can be added to a project from the context menu or command palette. */
export type AddServiceAction =
	| { kind: 'repo' }
	| { kind: 'image' }
	| { kind: 'database'; engine: DatabaseEngine }
	| { kind: 'empty' };

export const DATABASES: { engine: DatabaseEngine; label: string }[] = [
	{ engine: 'postgres', label: 'PostgreSQL' },
	{ engine: 'mysql', label: 'MySQL' },
	{ engine: 'redis', label: 'Redis' },
	{ engine: 'mongo', label: 'MongoDB' }
];
