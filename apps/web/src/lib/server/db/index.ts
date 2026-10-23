import { TRAMLINE_DATABASE_PATH } from '$app/env/private';
import { createDb } from './client';

export const db = createDb(TRAMLINE_DATABASE_PATH);

export * as schema from './schema';
export type { Db } from './client';
