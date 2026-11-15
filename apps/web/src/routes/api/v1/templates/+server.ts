import { endpoint } from '#lib/server/api/handler.js';
import * as templates from '#lib/server/templates/index.js';

/** The template gallery. */
export const GET = endpoint(() => templates.list());
