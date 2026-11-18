import {
	DEFAULT_SERVICE_CONFIG,
	InstallTemplate as InstallSchema,
	mergeConfig,
	parseReferences,
	Template as TemplateSchema,
	type GeneratedValue,
	type InstallTemplate,
	type InstalledTemplate,
	type Template,
	type TemplateInput,
	type TemplateSummary
} from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { createHmac, randomInt } from 'node:crypto';
import { AppError, notFound } from '../api/errors';
import { environment, node, sealedVariable, service, serviceInstance } from '../db/schema';
import { requireEnvironment, requireProject } from '../domain/access';
import * as changes from '../domain/changes';
import type { Ctx } from '../domain/context';
import { sealsChanged } from '../nodes/seals';
import { diffConfig, saveStaged, scopeOf } from '../domain/staging';
import { publish } from '../events';
import { newId } from '../ids';
import { replicaRequest } from '../nodes/placement';
import { n8n } from './n8n';
import { supabase } from './supabase';
import { uptimeKuma } from './uptime-kuma';

/** Tramline's gallery, in the order it's shown. Each one is checked when Tramline starts. */
export const TEMPLATES: Template[] = [supabase, n8n, uptimeKuma].map((t: TemplateInput) =>
	TemplateSchema.parse(t)
);

function requireTemplate(id: string) {
	const template = TEMPLATES.find((t) => t.id === id);
	if (!template) throw notFound('Template');
	return template;
}

export function summary(template: Template): TemplateSummary {
	const config = (s: Template['services'][number]) => mergeConfig(DEFAULT_SERVICE_CONFIG, s.config);
	const requests = template.services
		.map((s) => replicaRequest(config(s)))
		.reduce((sum, r) => ({ memoryMb: sum.memoryMb + r.memoryMb, cpus: sum.cpus + r.cpus }), {
			memoryMb: 0,
			cpus: 0
		});
	return {
		id: template.id,
		version: template.version,
		name: template.name,
		tagline: template.tagline,
		description: template.description,
		icon: template.icon,
		tags: template.tags,
		docsUrl: template.docsUrl ?? null,
		questions: template.questions,
		services: template.services.map((s) => ({
			key: s.key,
			name: s.name,
			icon: s.database ?? s.icon ?? null,
			image: s.image,
			publicDomain: !!config(s).networking.publicDomain,
			volume: !!config(s).volume.mountPath
		})),
		requests: { memoryMb: requests.memoryMb, cpus: Math.round(requests.cpus * 100) / 100 },
		notes: template.notes
	};
}

export function list(): TemplateSummary[] {
	return TEMPLATES.map(summary);
}

export function get(id: string): TemplateSummary {
	return summary(requireTemplate(id));
}

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Letters and digits only, so it's safe in URLs, connection strings and config files. */
export function generateSecret(length: number) {
	let out = '';
	for (let i = 0; i < length; i++) out += ALPHANUMERIC[randomInt(ALPHANUMERIC.length)];
	return out;
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** An HS256 JWT with `claims`, issued now and valid for `years`. */
export function signJwt(
	secret: string,
	claims: Record<string, string | number | boolean>,
	years: number,
	now = new Date()
) {
	const iat = Math.floor(now.getTime() / 1000);
	const exp = iat + Math.round(years * 365.25 * 24 * 3600);
	const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
	const payload = base64url(JSON.stringify({ ...claims, iat, exp }));
	const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
	return `${header}.${payload}.${signature}`;
}

const REFERENCE = /\$\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Rewrites a template's text for one install: `${{ answers.KEY }}` becomes
 * the answer, and `${{ key.VAR }}` names the service by the name it got.
 */
function rewrite(text: string, names: Map<string, string>, answers: Record<string, string>) {
	return text.replace(REFERENCE, (whole, namespace: string, key: string) => {
		if (namespace === 'answers') return answers[key] ?? '';
		const name = names.get(namespace);
		return name ? `\${{ ${name}.${key} }}` : whole;
	});
}

/** Each service's variables for one environment: generated values made, the rest as written. */
function variablesFor(
	template: Template,
	names: Map<string, string>,
	answers: Record<string, string>,
	now: Date
) {
	return new Map(
		template.services.map((s) => {
			const values: Record<string, string> = {};
			const generated = Object.entries(s.variables).filter(
				(entry): entry is [string, GeneratedValue] => typeof entry[1] !== 'string'
			);
			// secrets first: a JWT is signed with one of them
			for (const [key, value] of generated) {
				if (value.generate === 'secret') values[key] = generateSecret(value.length);
			}
			for (const [key, value] of generated) {
				if (value.generate !== 'jwt') continue;
				const secret = values[value.secret];
				if (!secret) {
					throw new AppError(
						'validation_failed',
						`${template.name}: ${s.key}.${key} is signed with ${value.secret}, which isn't a generated secret of ${s.key}`
					);
				}
				values[key] = signJwt(secret, value.claims, value.years, now);
			}
			for (const [key, value] of Object.entries(s.variables)) {
				if (typeof value === 'string') values[key] = rewrite(value, names, answers);
			}
			return [s.key, values] as const;
		})
	);
}

/** Variables that start out sealed: generated secrets (unless they say not) and secret answers. */
function sealedKeysOf(template: Template) {
	const secretAnswers = new Set(template.questions.filter((q) => q.secret).map((q) => q.key));
	return new Map(
		template.services.map((s) => [
			s.key,
			Object.entries(s.variables)
				.filter(([, value]) =>
					typeof value === 'string'
						? parseReferences(value).some(
								(ref) => ref.namespace === 'answers' && secretAnswers.has(ref.key)
							)
						: value.sealed
				)
				.map(([key]) => key)
		])
	);
}

function answersFor(template: Template, given: Record<string, string>) {
	const answers: Record<string, string> = {};
	for (const q of template.questions) {
		const value = (given[q.key] ?? '').trim() || q.default || '';
		if (q.required && !value) {
			throw new AppError('validation_failed', `${q.label} is required`);
		}
		// an answer is used as written; it can't smuggle in a reference
		if (value.includes('${{')) {
			throw new AppError('validation_failed', `${q.label} can't contain \${{`);
		}
		answers[q.key] = value;
	}
	return answers;
}

/**
 * Adds a template's services to a project, staged in every environment like
 * any new service: each environment gets its own generated secrets, sealed.
 * With `deploy`, that environment's changes are deployed straight away.
 */
export function install(ctx: Ctx, projectId: string, input: InstallTemplate): InstalledTemplate {
	const parsed = InstallSchema.parse(input);
	return installTemplate(ctx, projectId, requireTemplate(parsed.template), parsed);
}

/** `install` with the template itself, e.g. one that isn't in the gallery. */
export function installTemplate(
	ctx: Ctx,
	projectId: string,
	template: Template,
	input: InstallTemplate
): InstalledTemplate {
	requireProject(ctx, projectId);
	const parsed = InstallSchema.parse(input);
	if (parsed.deploy) {
		const env = requireEnvironment(ctx, parsed.deploy);
		if (env.projectId !== projectId) throw notFound('Environment');
	}
	if (
		parsed.node &&
		!ctx.db.select({ id: node.id }).from(node).where(eq(node.id, parsed.node)).get()
	) {
		throw notFound('Node');
	}
	const answers = answersFor(template, parsed.answers);

	// names the services get: their own, made unique in the project
	const taken = new Set(
		ctx.db
			.select({ name: service.name })
			.from(service)
			.where(eq(service.projectId, projectId))
			.all()
			.map((r) => r.name.toLowerCase())
	);
	const names = new Map<string, string>();
	for (const s of template.services) {
		let name = s.name;
		for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${s.name}-${n}`;
		taken.add(name.toLowerCase());
		names.set(s.key, name);
	}

	const origin = parsed.position ?? { x: 0, y: 0 };
	const sealed = sealedKeysOf(template);
	const now = new Date();
	const created = ctx.db.transaction((tx) => {
		const environments = tx
			.select({ id: environment.id })
			.from(environment)
			.where(eq(environment.projectId, projectId))
			.all();
		const perEnvironment = new Map(
			environments.map((env) => [env.id, variablesFor(template, names, answers, now)])
		);
		return template.services.map((s) => {
			const files = s.config.deploy?.files?.map((f) => ({
				path: f.path,
				content: rewrite(f.content, names, answers)
			}));
			// start order names the services by what they're called on the canvas
			const dependsOn = s.config.deploy?.dependsOn?.map((key) => names.get(key) ?? key);
			const config = mergeConfig(DEFAULT_SERVICE_CONFIG, {
				...s.config,
				source: { type: 'image', image: s.image },
				deploy: {
					...s.config.deploy,
					...(files ? { files } : {}),
					...(dependsOn ? { dependsOn } : {}),
					...(parsed.node ? { node: parsed.node } : {})
				}
			});
			const row = tx
				.insert(service)
				.values({
					id: newId('service'),
					projectId,
					name: names.get(s.key)!,
					kind: s.database ? 'database' : 'image',
					icon: s.database ?? s.icon ?? null,
					positionX: origin.x + s.position.x,
					positionY: origin.y + s.position.y
				})
				.returning()
				.get();
			for (const env of environments) {
				tx.insert(serviceInstance).values({ serviceId: row.id, environmentId: env.id }).run();
				const values = perEnvironment.get(env.id)!.get(s.key)!;
				saveStaged(tx, env.id, row.id, {
					create: true,
					config: diffConfig(DEFAULT_SERVICE_CONFIG, config),
					variables: {
						set: Object.fromEntries(
							Object.entries(values).map(([key, value]) => [key, ctx.secrets.encrypt(value)])
						),
						unset: []
					}
				});
				for (const key of sealed.get(s.key) ?? []) {
					tx.insert(sealedVariable)
						.values({ environmentId: env.id, serviceId: row.id, scope: scopeOf(row.id), key })
						.onConflictDoNothing()
						.run();
				}
			}
			return { key: s.key, id: row.id, name: row.name };
		});
	});
	sealsChanged();
	for (const s of created) publish({ type: 'services', projectId, serviceId: s.id });
	publish({ type: 'changes', projectId });

	const deployments = parsed.deploy
		? changes
				.deploy(ctx, parsed.deploy)
				.filter((d) => created.some((s) => s.id === d.serviceId))
				.map((d) => ({ id: d.id, serviceId: d.serviceId }))
		: [];
	return {
		template: { id: template.id, version: template.version, name: template.name },
		services: created,
		deployments,
		notes: template.notes.map((note) => rewrite(note, names, answers))
	};
}
