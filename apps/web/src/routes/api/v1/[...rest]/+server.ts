import { AppError } from '#lib/server/api/errors.js';
import { errorResponse } from '#lib/server/api/handler.js';
import type { RequestHandler } from './$types';

/** Unknown API routes return the JSON error envelope instead of an HTML 404 page. */
export const fallback: RequestHandler = () =>
	errorResponse(new AppError('not_found', 'No such API endpoint'));
