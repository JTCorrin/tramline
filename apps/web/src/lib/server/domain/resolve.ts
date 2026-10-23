import { parseReferences, replaceReferences, type VariableReference } from '@tramline/contracts';
import { AppError } from '../api/errors';

export interface ResolveService {
	id: string;
	name: string;
	variables: Record<string, string>;
	/** Values Tramline provides, e.g. TRAMLINE_PRIVATE_DOMAIN. Never contain references. */
	builtins: Record<string, string>;
}

export interface ResolveInput {
	shared: Record<string, string>;
	services: ResolveService[];
}

export interface ResolveResult {
	/** Runtime environment per service id: builtins overlaid with resolved variables. */
	variables: Map<string, Record<string, string>>;
	/** References that point at nothing; they resolve to an empty string. */
	missing: { serviceId: string; key: string; reference: string }[];
}

const label = (ref: VariableReference) => (ref.namespace ? `${ref.namespace}.${ref.key}` : ref.key);

/**
 * Resolves `${{ KEY }}`, `${{ shared.KEY }}` and `${{ Service.KEY }}` references
 * across an environment. Throws a `conflict` error when references form a cycle.
 */
export function resolveVariables(input: ResolveInput): ResolveResult {
	const byName = new Map(input.services.map((service) => [service.name, service]));
	const cache = new Map<string, string>();
	const visiting: string[] = [];
	const missing: ResolveResult['missing'] = [];

	function raw(scope: string, key: string): string | undefined {
		if (scope === 'shared') return input.shared[key];
		const service = byName.get(scope);
		return service?.variables[key] ?? service?.builtins[key];
	}

	function resolve(scope: string, key: string, origin: ResolveService): string | undefined {
		const id = `${scope}.${key}`;
		const cached = cache.get(id);
		if (cached !== undefined) return cached;

		if (visiting.includes(id)) {
			const loop = [...visiting.slice(visiting.indexOf(id)), id].join(' → ');
			throw new AppError('conflict', `Variables reference each other in a loop: ${loop}`);
		}

		const value = raw(scope, key);
		if (value === undefined) return undefined;

		visiting.push(id);
		const resolved = replaceReferences(value, (ref) => {
			const target = ref.namespace ?? scope;
			const result = resolve(target, ref.key, origin);
			if (result === undefined) {
				missing.push({ serviceId: origin.id, key, reference: label(ref) });
			}
			return result;
		});
		visiting.pop();
		cache.set(id, resolved);
		return resolved;
	}

	const variables = new Map<string, Record<string, string>>();
	for (const service of input.services) {
		const env: Record<string, string> = { ...service.builtins };
		for (const key of Object.keys(service.variables)) {
			env[key] = resolve(service.name, key, service) ?? '';
		}
		variables.set(service.id, env);
	}
	return { variables, missing };
}

/** Service names a service's variables point at (excluding itself and `shared`). */
export function referencedServices(variables: Record<string, string>, self: string) {
	const names = new Set<string>();
	for (const value of Object.values(variables)) {
		for (const ref of parseReferences(value)) {
			if (ref.namespace && ref.namespace !== 'shared' && ref.namespace !== self) {
				names.add(ref.namespace);
			}
		}
	}
	return names;
}

/** Variables Tramline injects into every service. */
export function builtinVariables(
	service: { id: string; name: string },
	environment: { id: string; name: string },
	port: number | null,
	publicDomain: string | null = null,
	mountPath: string | null = null
): Record<string, string> {
	const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
	return {
		TRAMLINE_SERVICE_ID: service.id,
		TRAMLINE_SERVICE_NAME: service.name,
		TRAMLINE_ENVIRONMENT_ID: environment.id,
		TRAMLINE_ENVIRONMENT_NAME: environment.name,
		TRAMLINE_PRIVATE_DOMAIN: `${slug(service.name)}.${slug(environment.name)}.tramline.internal`,
		...(port ? { PORT: String(port) } : {}),
		...(publicDomain ? { TRAMLINE_PUBLIC_DOMAIN: publicDomain } : {}),
		...(mountPath ? { TRAMLINE_VOLUME_MOUNT_PATH: mountPath } : {})
	};
}
