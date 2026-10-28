import { describe, expect, it } from 'vitest';
import {
	CIDR,
	Hostname,
	SaveBackupStorage,
	VolumeConfig,
	CreateProject,
	CreateService,
	DEFAULT_SERVICE_CONFIG,
	ServiceConfigPatch,
	StageVariables,
	UpdateProject,
	Variable,
	mergeConfig,
	parseReferences,
	replaceReferences
} from './index';

describe('variable references', () => {
	it('parses self, shared and cross-service references, tolerating spaces', () => {
		expect(parseReferences('postgres://${{PGUSER}}@${{ Postgres.HOST }}:${{shared.PORT}}')).toEqual(
			[
				{ namespace: null, key: 'PGUSER' },
				{ namespace: 'Postgres', key: 'HOST' },
				{ namespace: 'shared', key: 'PORT' }
			]
		);
	});

	it('ignores malformed references', () => {
		expect(parseReferences('${PLAIN} ${{ }} ${{1BAD}} {{X}}')).toEqual([]);
	});

	it('replaces references and blanks unknown ones', () => {
		const lookup = ({ namespace, key }: { namespace: string | null; key: string }) =>
			namespace === 'shared' && key === 'A' ? 'one' : undefined;
		expect(replaceReferences('[${{shared.A}}|${{shared.B}}]', lookup)).toBe('[one|]');
	});
});

describe('mergeConfig', () => {
	it('merges sections shallowly and leaves the base untouched', () => {
		const merged = mergeConfig(DEFAULT_SERVICE_CONFIG, {
			deploy: { replicas: 3 },
			networking: { publicDomain: true }
		});
		expect(merged.deploy).toEqual({ ...DEFAULT_SERVICE_CONFIG.deploy, replicas: 3 });
		expect(merged.networking.publicDomain).toBe(true);
		expect(DEFAULT_SERVICE_CONFIG.deploy.replicas).toBe(1);
	});

	it('distinguishes clearing the source from leaving it alone', () => {
		const withImage = mergeConfig(DEFAULT_SERVICE_CONFIG, {
			source: { type: 'image', image: 'nginx' }
		});
		expect(mergeConfig(withImage, {}).source).toEqual({ type: 'image', image: 'nginx' });
		expect(mergeConfig(withImage, { source: null }).source).toBeNull();
	});
});

describe('schemas', () => {
	it('trims project names and rejects empty ones', () => {
		expect(CreateProject.parse({ name: '  Shop ' }).name).toBe('Shop');
		expect(CreateProject.safeParse({ name: '   ' }).success).toBe(false);
		expect(UpdateProject.parse({ description: null })).toEqual({ description: null });
	});

	it('validates service names', () => {
		const base = { projectId: 'prj_1', kind: 'empty' as const };
		expect(CreateService.safeParse({ ...base, name: 'api-2_x' }).success).toBe(true);
		expect(CreateService.safeParse({ ...base, name: 'has space' }).success).toBe(false);
		expect(CreateService.safeParse({ ...base, name: '-leading' }).success).toBe(false);
	});

	it('represents sealed variables without their value', () => {
		expect(Variable.parse({ key: 'K', value: null, sealed: true, staged: null })).toMatchObject({
			value: null
		});
		expect(Variable.safeParse({ key: 'K', value: null, staged: null }).success).toBe(false);
	});

	it('defaults new deploy settings to unrestricted', () => {
		expect(DEFAULT_SERVICE_CONFIG.deploy).toMatchObject({
			memoryMb: null,
			readOnlyRootFilesystem: false
		});
		expect(ServiceConfigPatch.safeParse({ deploy: { memoryMb: 8 } }).success).toBe(false);
	});

	it('turns blank optional config text into null', () => {
		expect(ServiceConfigPatch.parse({ deploy: { startCommand: '  ' } })).toEqual({
			deploy: { startCommand: null }
		});
		expect(ServiceConfigPatch.safeParse({ deploy: { replicas: 0 } }).success).toBe(false);
		expect(ServiceConfigPatch.safeParse({ networking: { port: 70000 } }).success).toBe(false);
	});

	it('validates variable keys and defaults set/unset', () => {
		expect(StageVariables.parse({ environmentId: 'env_1' })).toEqual({
			environmentId: 'env_1',
			set: {},
			unset: [],
			seal: [],
			restore: []
		});
		expect(StageVariables.safeParse({ environmentId: 'e', seal: ['bad key'] }).success).toBe(false);
		expect(StageVariables.safeParse({ environmentId: 'e', set: { '1BAD': 'x' } }).success).toBe(
			false
		);
		expect(StageVariables.safeParse({ environmentId: 'e', unset: ['OK_KEY'] }).success).toBe(true);
	});
});

describe('VolumeConfig', () => {
	const mount = (mountPath: string | null) => VolumeConfig.safeParse({ mountPath });

	it('takes an absolute data directory, or none', () => {
		expect(mount('/var/lib/postgresql/data').data).toEqual({
			mountPath: '/var/lib/postgresql/data'
		});
		expect(mount(' /data ').data).toEqual({ mountPath: '/data' });
		expect(mount(null).success).toBe(true);
	});

	it('refuses relative paths and system directories', () => {
		expect(mount('data').error?.issues[0]?.message).toBe('Use an absolute path, like /data');
		for (const path of ['/', '//', '/proc', '/sys/', '/dev']) {
			expect(mount(path).error?.issues[0]?.message).toBe(
				'Choose a directory for the data, like /data'
			);
		}
	});
});

describe('SaveBackupStorage', () => {
	const base = { endpoint: 'https://s3.example.com', bucket: 'my-backups', accessKeyId: 'AKID' };

	it('normalises the endpoint and folder and fills defaults', () => {
		expect(
			SaveBackupStorage.parse({
				...base,
				endpoint: ' https://s3.example.com/// ',
				prefix: '/tramline/prod/'
			})
		).toEqual({
			...base,
			region: 'us-east-1',
			prefix: 'tramline/prod',
			pathStyle: true
		});
	});

	it('refuses bad endpoints and bucket names', () => {
		const issue = (input: object) =>
			SaveBackupStorage.safeParse({ ...base, ...input }).error?.issues[0]?.message;
		expect(issue({ endpoint: 'ftp://s3.example.com' })).toBe(
			'Use the bucket service’s http(s) URL'
		);
		expect(issue({ bucket: 'Has_Upper' })).toBe('Not a valid bucket name');
		expect(issue({ accessKeyId: ' ' })).toBe('Access key ID is required');
	});
});

describe('Hostname', () => {
	it('normalises case, whitespace and a trailing dot', () => {
		expect(Hostname.parse(' Shop.Example.COM. ')).toBe('shop.example.com');
	});

	it('refuses IP addresses and malformed names', () => {
		expect(Hostname.safeParse('10.0.0.1').error?.issues[0]?.message).toBe(
			'Use a domain name, not an IP address'
		);
		expect(Hostname.safeParse('no-dot').error?.issues[0]?.message).toBe(
			'Enter a domain like app.example.com'
		);
	});
});

describe('TCP allowlist addresses', () => {
	it.each(['999.1.2.3', '192.0.2.1/99', '2001:db8::/129', 'abc', '1:2:3', '192.0.2.1/-1', '::/'])(
		'rejects invalid address or prefix %s',
		(value) => {
			expect(CIDR.safeParse(value).success).toBe(false);
			expect(ServiceConfigPatch.safeParse({ networking: { tcpAllowlist: [value] } }).success).toBe(
				false
			);
		}
	);
	it.each(['192.0.2.1', '0.0.0.0/0', '192.0.2.1/32', '2001:db8::1', '::/0', '2001:db8::1/128'])(
		'accepts valid address or prefix %s',
		(value) => {
			expect(CIDR.parse(` ${value} `)).toBe(value);
		}
	);
});
