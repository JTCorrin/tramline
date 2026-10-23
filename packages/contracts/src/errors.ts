import { z } from 'zod';

export const ERROR_CODES = [
	'bad_request',
	'validation_failed',
	'unauthenticated',
	'forbidden',
	'not_found',
	'conflict',
	'internal'
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorCodeStatus: Record<ErrorCode, number> = {
	bad_request: 400,
	validation_failed: 422,
	unauthenticated: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	internal: 500
};

/** Every non-2xx response from `/api/v1` has this shape. */
export const ApiErrorBody = z.object({
	error: z.object({
		code: z.enum(ERROR_CODES),
		message: z.string(),
		issues: z.array(z.object({ path: z.string(), message: z.string() })).optional()
	})
});

export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
