import { ErrorCodeStatus, type ApiErrorBody, type ErrorCode } from '@tramline/contracts';
import type { z } from 'zod';

type Issues = ApiErrorBody['error']['issues'];

/** Domain-level error. API handlers turn it into the standard error envelope. */
export class AppError extends Error {
	readonly code: ErrorCode;
	readonly issues: Issues;

	constructor(code: ErrorCode, message: string, issues?: Issues) {
		super(message);
		this.name = 'AppError';
		this.code = code;
		this.issues = issues;
	}

	get status() {
		return ErrorCodeStatus[this.code];
	}

	toBody(): ApiErrorBody {
		return { error: { code: this.code, message: this.message, issues: this.issues } };
	}
}

export const notFound = (what: string) => new AppError('not_found', `${what} not found`);

export function validationFailed(error: z.ZodError) {
	return new AppError(
		'validation_failed',
		error.issues[0]?.message ?? 'Invalid input',
		error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
	);
}
