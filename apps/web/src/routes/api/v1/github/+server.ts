import { endpoint } from '#lib/server/api/handler.js';
import { status } from '#lib/server/github/app.js';
import { settings } from '#lib/server/settings.server.js';

export const GET = endpoint((ctx) => status(ctx, settings));
