import { UpdateVolume } from '@tramline/contracts';
import { body, endpoint } from '#lib/server/api/handler.js';
import { backups } from '#lib/server/domain/index.js';

/** Changes the backup schedule; applies at once, without a deploy. */
export const PATCH = endpoint(async (ctx, event) =>
	backups.updateVolume(ctx, event.params.id!, await body(event, UpdateVolume))
);
