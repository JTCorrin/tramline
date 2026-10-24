import { DEFAULT_SERVICE_CONFIG, type ServiceConfig } from '@tramline/contracts';
import { describe, expect, it } from 'vitest';
import { touchesRoot, touchesWatchPaths, wantsDeploy } from './autodeploy';

describe('touchesWatchPaths', () => {
	it.each([
		[['src/**'], 'src/app/main.ts', true],
		[['src/**'], 'lib/app.ts', false],
		[['*.go'], 'cmd/server/main.go', true],
		[['/go.mod'], 'go.mod', true],
		[['/go.mod'], 'vendor/x/go.mod', false],
		[['docs/'], 'docs/guide/intro.md', true],
		[['src/*.ts'], 'src/a/b.ts', false],
		[['src/?.ts'], 'src/a.ts', true],
		[['package.json'], 'apps/web/package.json', true],
		[['src/**', '!**/*.test.ts'], 'src/app.test.ts', false],
		[['src/**', '!**/*.test.ts'], 'src/app.ts', true],
		[['!**/*.md', 'docs/**'], 'docs/a.md', true],
		[['a+b/(x).ts'], 'a+b/(x).ts', true]
	])('%j matches %s: %s', (patterns, file, expected) => {
		expect(touchesWatchPaths([file], patterns)).toBe(expected);
	});

	it('counts any change when there are no patterns', () => {
		expect(touchesWatchPaths(['anything'], [])).toBe(true);
	});
});

describe('wantsDeploy', () => {
	const repo = (rootDirectory: string, watchPaths: string[]): ServiceConfig => ({
		...DEFAULT_SERVICE_CONFIG,
		source: { type: 'repo', repo: 'https://github.com/a/b', branch: 'main', rootDirectory },
		build: { ...DEFAULT_SERVICE_CONFIG.build, watchPaths }
	});

	it('needs both the root directory and the watch paths', () => {
		expect(wantsDeploy(['api/src/a.ts'], repo('/api', ['api/src/**']))).toBe(true);
		expect(wantsDeploy(['web/src/a.ts'], repo('/api', []))).toBe(false);
		expect(wantsDeploy(['api/README.md'], repo('/api', ['api/src/**']))).toBe(false);
		expect(wantsDeploy(['a.ts'], { ...DEFAULT_SERVICE_CONFIG })).toBe(false);
		expect(touchesRoot(['api'], '/api/')).toBe(true);
	});
});
