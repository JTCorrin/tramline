import { parseReferences, Template } from '@tramline/contracts';
import { describe, expect, it } from 'vitest';
import { supabase } from './supabase';

const template = Template.parse(supabase);
const services = new Map(template.services.map((s) => [s.key, s]));
const questions = new Set(template.questions.map((q) => q.key));

/** What a service can refer to besides its own variables: Tramline's builtins. */
function builtins(key: string, crossService: boolean) {
	const s = services.get(key)!;
	const names = new Set(['TRAMLINE_PRIVATE_DOMAIN']);
	if (s.config.networking?.publicDomain) names.add('TRAMLINE_PUBLIC_DOMAIN');
	if (!crossService) {
		for (const name of [
			'TRAMLINE_SERVICE_NAME',
			'TRAMLINE_SERVICE_ID',
			'TRAMLINE_ENVIRONMENT_NAME'
		])
			names.add(name);
		if (s.config.networking?.port) names.add('PORT');
	}
	return names;
}

const stringVariables = (s: (typeof template.services)[number]) =>
	Object.entries(s.variables).filter((e): e is [string, string] => typeof e[1] === 'string');

describe('the Supabase template', () => {
	it('parses', () => {
		expect(template.id).toBe('supabase');
		expect([...services.keys()].sort()).toEqual(
			['auth', 'db', 'kong', 'meta', 'realtime', 'rest', 'storage', 'studio'].sort()
		);
		for (const s of template.services) expect(s.name).toBe(s.key);
	});

	it('only refers to variables that exist', () => {
		const problems: string[] = [];
		for (const s of template.services) {
			for (const [key, value] of stringVariables(s)) {
				for (const ref of parseReferences(value)) {
					const where = `${s.key}.${key} -> ${ref.namespace ?? ''}.${ref.key}`;
					if (ref.namespace === 'answers') {
						if (!questions.has(ref.key)) problems.push(`${where}: no such question`);
						continue;
					}
					const target = ref.namespace ?? s.key;
					const other = services.get(target);
					if (!other) {
						problems.push(`${where}: no such service`);
						continue;
					}
					if (target === s.key && ref.key === key) problems.push(`${where}: refers to itself`);
					const ok =
						ref.key in other.variables || builtins(target, ref.namespace !== null).has(ref.key);
					if (!ok) problems.push(`${where}: not defined`);
				}
			}
		}
		expect(problems).toEqual([]);
	});

	it("only uses a service's own variables in its files", () => {
		const problems: string[] = [];
		for (const s of template.services) {
			for (const file of s.config.deploy?.files ?? []) {
				for (const ref of parseReferences(file.content)) {
					if (ref.namespace !== null) problems.push(`${s.key}:${file.path}: ${ref.namespace}.`);
					else if (!(ref.key in s.variables) && !builtins(s.key, false).has(ref.key))
						problems.push(`${s.key}:${file.path}: ${ref.key}`);
				}
			}
		}
		expect(problems).toEqual([]);
	});

	it('fills in every variable Kong’s config uses', () => {
		const kong = services.get('kong')!;
		const config = kong.config.deploy!.files!.find((f) => f.path === '/home/kong/kong.yml')!;
		expect(kong.variables.KONG_DECLARATIVE_CONFIG).toBe(config.path);
		// no `$VAR` left over from compose's eval-echo entrypoint
		const yaml = config.content.replace(/^\s*#.*$/gm, '');
		expect(yaml).not.toMatch(/\$(?!\{\{)[A-Z_]/);
		const used = new Set(parseReferences(config.content).map((r) => r.key));
		expect([...used].sort()).toEqual(
			[
				'AUTH_HOST',
				'REALTIME_HOST',
				'REST_HOST',
				'STORAGE_HOST',
				'SUPABASE_ANON_KEY',
				'SUPABASE_SERVICE_KEY'
			].sort()
		);
	});

	it('signs its JWTs with a generated secret of the same service', () => {
		const jwts = template.services.flatMap((s) =>
			Object.entries(s.variables).flatMap(([key, value]) =>
				typeof value !== 'string' && value.generate === 'jwt' ? [{ s, key, value }] : []
			)
		);
		expect(jwts.map((j) => j.key).sort()).toEqual(['ANON_KEY', 'SERVICE_ROLE_KEY']);
		for (const { s, value } of jwts) {
			const secret = s.variables[value.secret];
			expect(typeof secret === 'object' && secret.generate).toBe('secret');
		}
		const auth = services.get('auth')!.variables;
		expect(auth.ANON_KEY).toMatchObject({ claims: { role: 'anon' }, sealed: false });
		expect(auth.SERVICE_ROLE_KEY).toMatchObject({ claims: { role: 'service_role' }, sealed: true });
		expect(auth.JWT_SECRET).toMatchObject({ generate: 'secret' });
		expect((auth.JWT_SECRET as { length: number }).length).toBeGreaterThanOrEqual(40);
	});

	it('puts only Kong on a public domain, and Studio nowhere near it', () => {
		const pub = template.services
			.filter((s) => s.config.networking?.publicDomain)
			.map((s) => s.key);
		expect(pub).toEqual(['kong']);
		expect(services.get('studio')!.config.networking?.publicDomain).toBeFalsy();
		const kong = services.get('kong')!;
		// the config without its comments, which say what was taken out
		const config = kong.config.deploy!.files![0]!.content.replace(/^\s*#.*$/gm, '');
		expect(config).not.toMatch(/studio|dashboard|basic-?auth|:3000\/api/i);
		// every upstream is one of the *_HOST variables...
		const upstreams = [...config.matchAll(/url: (.+)$/gm)].map((m) => m[1]!);
		expect(upstreams.length).toBeGreaterThan(0);
		for (const url of upstreams) expect(url).toMatch(/^http:\/\/\$\{\{ [A-Z]+_HOST \}\}:\d+\//);
		// ...and none of them is Studio or postgres-meta (which runs any SQL)
		const hosts = stringVariables(kong).filter(([key]) => key.endsWith('_HOST'));
		for (const [, value] of hosts) expect(value).not.toMatch(/\b(studio|meta)\./);
		expect(config).not.toMatch(/\/pg\/|:8080/);
	});

	it('keeps the database private, with the superuser backups run as', () => {
		const db = services.get('db')!;
		expect(db.database).toBe('postgres');
		expect(db.config.networking?.tcpProxy).toBe(false);
		expect(db.variables.POSTGRES_USER).toBe('supabase_admin');
		expect(db.config.volume?.mountPath).toBe('/var/lib/postgresql/data');
	});

	it('restarts everything, since nothing waits for the database', () => {
		for (const s of template.services) expect(s.config.deploy?.restartPolicy).toBe('always');
	});

	it('reserves what the stack needs, within a 4 GB node', () => {
		const total = template.services.reduce(
			(sum, s) => sum + (s.config.deploy?.memoryRequestMb ?? 0),
			0
		);
		for (const s of template.services) expect(s.config.deploy?.memoryRequestMb).toBeGreaterThan(0);
		expect(total).toBeLessThanOrEqual(2048);
	});
});
