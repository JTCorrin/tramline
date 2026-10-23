import { endpoint } from '#lib/server/api/handler.js';
import { repos } from '#lib/server/github/app.js';

export const GET = endpoint((ctx) => repos(ctx));
