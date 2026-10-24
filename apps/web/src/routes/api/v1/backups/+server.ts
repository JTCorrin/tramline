import { z } from 'zod';
import { body, endpoint, param } from '#lib/server/api/handler.js';
import { backups } from '#lib/server/domain/index.js';

export const GET = endpoint((ctx, event) => backups.listBackups(ctx, param(event, 'volumeId')));

/** Backs a volume up now. */
export const POST = endpoint(async (ctx, event) =>
	backups.backUp(ctx, (await body(event, z.object({ volumeId: z.string() }))).volumeId)
);
