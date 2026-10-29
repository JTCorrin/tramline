import { endpoint } from '#lib/server/api/handler.js';
import { listAdapters } from '#lib/server/adapters/registry.js';

/** The compute adapters this install offers, with each one's credentials form. */
export const GET = endpoint(() => listAdapters());
