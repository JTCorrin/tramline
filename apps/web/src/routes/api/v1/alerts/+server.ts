import { endpoint } from '#lib/server/api/handler.js';
import { metrics } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx) => metrics.listAlerts(ctx));
