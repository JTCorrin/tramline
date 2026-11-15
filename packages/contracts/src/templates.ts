import { z } from 'zod';
import { DATABASE_ENGINES, ServiceConfigPatch } from './services';
import { VariableKey } from './variables';

/**
 * Templates: a whole stack (services, volumes, references and generated
 * secrets) added to a project at once, from Tramline's gallery. A template
 * is the `tramline.json` format: what each service is, and what it needs.
 *
 * In variable values and file contents:
 *
 * - `${{ answers.KEY }}` is replaced at install by the answer to a question;
 * - `${{ Service.KEY }}` names another service by its key in the template,
 *   and is rewritten to the name it gets on the canvas;
 * - anything else is an ordinary reference, resolved when it deploys.
 */

const KEY = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, 'Use lowercase letters, numbers and dashes');

/** Something to ask whoever installs the template, e.g. the site's URL. */
export const TemplateQuestion = z.object({
	key: VariableKey,
	label: z.string().min(1).max(80),
	description: z.string().max(300).optional(),
	placeholder: z.string().max(200).optional(),
	default: z.string().max(500).optional(),
	required: z.boolean().default(false),
	/** Asked for with a password field, and stored sealed. */
	secret: z.boolean().default(false)
});
export type TemplateQuestion = z.infer<typeof TemplateQuestion>;

/** A value Tramline makes at install: a new one for each environment. */
export const GeneratedValue = z.discriminatedUnion('generate', [
	z.object({
		generate: z.literal('secret'),
		/** Characters; letters and digits only, so it's safe in URLs and configs. */
		length: z.number().int().min(16).max(128).default(40),
		sealed: z.boolean().default(true)
	}),
	z.object({
		/** An HS256 JWT signed with another of the same service's variables (a generated secret). */
		generate: z.literal('jwt'),
		secret: VariableKey,
		claims: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
		/** How long it's valid, in years from install. */
		years: z.number().int().min(1).max(20).default(10),
		sealed: z.boolean().default(true)
	})
]);
export type GeneratedValue = z.infer<typeof GeneratedValue>;

export const TemplateService = z.object({
	/** How the template refers to it: `${{ db.POSTGRES_PASSWORD }}`. */
	key: KEY,
	/** Its name on the canvas, made unique if the project has one already. */
	name: KEY,
	/** A service icon (`postgres`, `redis`…) or a lucide icon name. */
	icon: z.string().max(40).optional(),
	/**
	 * It's this kind of database, as one added from the canvas is: it's backed
	 * up with the engine's own dump, and (Postgres) can have the TCP proxy.
	 * Its icon is the engine's.
	 */
	database: z.enum(DATABASE_ENGINES).optional(),
	/** A registry image, pinned by digest: `supabase/gotrue:v2.197.0@sha256:…`. */
	image: z.string().regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/, 'Pin the image by digest'),
	/** Deploy, networking and volume settings, as a hand-built service has them. */
	config: ServiceConfigPatch.omit({ source: true, build: true }).default({}),
	variables: z.record(VariableKey, z.union([z.string().max(4096), GeneratedValue])).default({}),
	/** Where it sits on the canvas, relative to the template's first service. */
	position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 })
});
export type TemplateService = z.input<typeof TemplateService>;

export const Template = z.object({
	id: KEY,
	/** Bumped whenever what it installs changes. */
	version: z.number().int().positive(),
	name: z.string().min(1).max(60),
	/** One line for the gallery. */
	tagline: z.string().min(1).max(120),
	description: z.string().max(2000),
	icon: z.string().max(40),
	tags: z.array(z.string().max(30)).max(8).default([]),
	docsUrl: z.url().optional(),
	questions: z.array(TemplateQuestion).max(10).default([]),
	services: z.array(TemplateService).min(1).max(20),
	/** What to know once it's added, e.g. where Studio is. Shown after install. */
	notes: z.array(z.string().max(500)).max(10).default([])
});
export type Template = z.infer<typeof Template>;
export type TemplateInput = z.input<typeof Template>;

/** What the gallery shows of a template. */
export const TemplateSummary = z.object({
	id: z.string(),
	version: z.number(),
	name: z.string(),
	tagline: z.string(),
	description: z.string(),
	icon: z.string(),
	tags: z.array(z.string()),
	docsUrl: z.string().nullable(),
	questions: z.array(TemplateQuestion),
	services: z.array(
		z.object({
			key: z.string(),
			name: z.string(),
			icon: z.string().nullable(),
			image: z.string(),
			publicDomain: z.boolean(),
			volume: z.boolean()
		})
	),
	/** What its services reserve together, so it's clear what it needs from a node. */
	requests: z.object({ memoryMb: z.number(), cpus: z.number() }),
	notes: z.array(z.string())
});
export type TemplateSummary = z.infer<typeof TemplateSummary>;

export const InstallTemplate = z.object({
	template: z.string().min(1),
	/** Answers to its questions, by key. */
	answers: z.record(z.string(), z.string().max(500)).default({}),
	/** Where on the canvas its first service goes. */
	position: z.object({ x: z.number(), y: z.number() }).optional(),
	/** Deploy it in this environment straight away, instead of leaving it staged. */
	deploy: z.string().nullable().default(null)
});
export type InstallTemplate = z.input<typeof InstallTemplate>;

export const InstalledTemplate = z.object({
	template: z.object({ id: z.string(), version: z.number(), name: z.string() }),
	/** The services it added, by their key in the template. */
	services: z.array(z.object({ key: z.string(), id: z.string(), name: z.string() })),
	/** Deployments started, when it was deployed straight away. */
	deployments: z.array(z.object({ id: z.string(), serviceId: z.string() })),
	notes: z.array(z.string())
});
export type InstalledTemplate = z.infer<typeof InstalledTemplate>;
