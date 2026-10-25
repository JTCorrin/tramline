import { endpoint } from '#lib/server/api/handler.js';
import { tokens } from '#lib/server/domain/index.js';

/** Recent changes in the organization, for owners and admins. */
export const GET = endpoint((ctx) => tokens.auditLog(ctx), { session: true });
