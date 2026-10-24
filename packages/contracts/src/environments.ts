import { z } from 'zod';

export const Environment = z.object({
	id: z.string(),
	projectId: z.string(),
	name: z.string(),
	createdAt: z.iso.datetime()
});

export type Environment = z.infer<typeof Environment>;

const name = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'Use lowercase letters, numbers and dashes');

export const CreateEnvironment = z.object({
	projectId: z.string(),
	name,
	/** Duplicate this environment: its config and variables (databases get new credentials). */
	copyFrom: z.string().optional()
});
export type CreateEnvironment = z.infer<typeof CreateEnvironment>;

export const UpdateEnvironment = z.object({ name });
export type UpdateEnvironment = z.infer<typeof UpdateEnvironment>;
