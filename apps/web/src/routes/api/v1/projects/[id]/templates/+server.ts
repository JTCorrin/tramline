import { InstallTemplate } from '@tramline/contracts';
import { AppError } from '#lib/server/api/errors.js';
import { body, endpoint } from '#lib/server/api/handler.js';
import { allows } from '#lib/server/domain/tokens.js';
import * as templates from '#lib/server/templates/index.js';

/**
 * Adds a template's services to the project, staged. With `deploy`, that
 * environment's changes are deployed too, which a token needs `deploy` for.
 */
export const POST = endpoint(async (ctx, event) => {
	const input = await body(event, InstallTemplate);
	if (input.deploy && ctx.token && !allows(ctx.token.scopes, 'deploy')) {
		throw new AppError('forbidden', 'This token needs the deploy scope');
	}
	return templates.install(ctx, event.params.id!, input);
});
