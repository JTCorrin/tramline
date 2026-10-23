import { endpoint } from '#lib/server/api/handler.js';
import { disconnectInstallation } from '#lib/server/github/app.js';

/** Disconnects an installation from the organization (it stays installed on GitHub). */
export const DELETE = endpoint((ctx, { params }) => disconnectInstallation(ctx, params.id!));
