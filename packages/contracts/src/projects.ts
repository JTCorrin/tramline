import { z } from 'zod';

export const Project = z.object({
	id: z.string(),
	organizationId: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime()
});

export type Project = z.infer<typeof Project>;

const name = z.string().trim().min(1, 'Name is required').max(64, 'Name is too long');
const description = z.string().trim().max(280, 'Description is too long');

export const CreateProject = z.object({
	name,
	description: description.optional()
});

export type CreateProject = z.infer<typeof CreateProject>;

export const UpdateProject = z
	.object({
		name,
		description: description.nullable()
	})
	.partial();

export type UpdateProject = z.infer<typeof UpdateProject>;
