import { endpoint } from '#lib/server/api/handler.js';
import * as templates from '#lib/server/templates/index.js';

export const GET = endpoint((_ctx, { params }) => templates.get(params.id!));
